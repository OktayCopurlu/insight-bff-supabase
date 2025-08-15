// Lightweight text translation cache + stub provider for BFF
// - In-memory LRU-ish cache to avoid repeat work
// - Optional DB-backed cache via Supabase table `translations` (key, src_lang, dst_lang, text)

import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;
try {
  if (SUPABASE_URL && SERVICE_KEY) {
    supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });
  }
} catch (_) {}

const MAX_CACHE = parseInt(process.env.TRANSLATION_CACHE_MAX || "500");
const cache = new Map(); // key -> text

// Timeouts and retry knobs
const MT_TIMEOUT_MS = parseInt(process.env.MT_TIMEOUT_MS || "1200");
const MT_RETRIES = parseInt(process.env.MT_RETRIES || "2");
const MT_BACKOFF_MS = parseInt(process.env.MT_BACKOFF_MS || "150");

function withTimeout(promiseLike, ms, label = "op") {
  let to;
  const p =
    typeof promiseLike.finally === "function"
      ? promiseLike
      : Promise.resolve(promiseLike);
  return Promise.race([
    p.finally(() => clearTimeout(to)),
    new Promise((_, rej) => {
      to = setTimeout(
        () => rej(new Error(`${label} timed out after ${ms}ms`)),
        ms
      );
    }),
  ]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lruSet(k, v) {
  if (cache.has(k)) cache.delete(k);
  cache.set(k, v);
  if (cache.size > MAX_CACHE) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

function keyFor(text, src, dst) {
  const h = crypto
    .createHash("sha1")
    .update(`${src}|${dst}|${text}`)
    .digest("hex");
  return `${src}->${dst}:${h}`;
}

async function translateViaProvider(text, srcLang, dstLang) {
  const provider = (process.env.MT_PROVIDER || "").toLowerCase();
  // Gemini (Generative Language API)
  if (provider === "gemini" && process.env.GEMINI_API_KEY) {
    const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const prompt = `Translate the following text from ${
      srcLang || "auto"
    } to ${dstLang}. Return only the translation with no extra words or quotes.\n\n${text}`;
    const body = {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: { temperature: 0 },
    };
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}`);
    const json = await resp.json();
    const out = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!out) throw new Error("Gemini no translation");
    return out;
  }
  // OpenAI Chat Completions
  if (provider === "openai" && process.env.OPENAI_API_KEY) {
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You are a high-quality translator. Return only the translated text, no commentary, no quotes.",
          },
          {
            role: "user",
            content: `Translate from ${
              srcLang || "auto"
            } to ${dstLang}:\n\n${text}`,
          },
        ],
      }),
    });
    if (!resp.ok) throw new Error(`OpenAI HTTP ${resp.status}`);
    const json = await resp.json();
    const out = json?.choices?.[0]?.message?.content;
    if (!out) throw new Error("OpenAI no translation");
    return out.trim();
  }
  // DeepL
  if (provider === "deepl" && process.env.DEEPL_API_KEY) {
    // Map BCP-47 → DeepL code (best-effort): keep region if present, else primary upper
    const norm = (tag) => {
      if (!tag) return undefined;
      const [p, region] = String(tag).split("-");
      if (region) return `${p.toUpperCase()}-${region.toUpperCase()}`;
      return p.toUpperCase();
    };
    const target = norm(dstLang);
    const source = srcLang && srcLang !== "auto" ? norm(srcLang) : undefined;
    const apiUrl =
      process.env.DEEPL_API_URL || "https://api-free.deepl.com/v2/translate";
    const params = new URLSearchParams();
    params.set("auth_key", process.env.DEEPL_API_KEY);
    params.set("text", text);
    params.set("target_lang", target);
    if (source) params.set("source_lang", source);
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    if (!resp.ok) throw new Error(`DeepL HTTP ${resp.status}`);
    const json = await resp.json();
    const out = json?.translations?.[0]?.text;
    if (!out) throw new Error("DeepL no translation");
    return out;
  }
  // Default fallback: return original + optional marker
  const marker =
    process.env.BFF_TRANSLATION_TAG === "off" ? "" : " [translated]";
  return text + marker;
}

async function attemptTranslateWithRetries(text, srcLang, dstLang) {
  let lastErr = null;
  for (let i = 0; i <= MT_RETRIES; i++) {
    try {
      const out = await withTimeout(
        translateViaProvider(text, srcLang, dstLang),
        MT_TIMEOUT_MS,
        "translate provider"
      );
      return out;
    } catch (e) {
      lastErr = e;
      if (i < MT_RETRIES) await sleep(MT_BACKOFF_MS * (i + 1));
    }
  }
  // Fallback: ensure we still return a target-appropriate string even if provider repeatedly failed
  const marker =
    process.env.BFF_TRANSLATION_TAG === "off" ? "" : " [translated]";
  console.warn(
    "translateTextCached: provider failed, returning fallback:",
    lastErr?.message || lastErr
  );
  return text + marker;
}

export async function translateTextCached(text, { srcLang = "auto", dstLang }) {
  if (!text || !dstLang) return text;
  const key = keyFor(text, srcLang, dstLang);
  // memory
  if (cache.has(key)) return cache.get(key);
  // db
  if (supabase) {
    try {
      const { data } = await withTimeout(
        supabase
          .from("translations")
          .select("text")
          .eq("key", key)
          .maybeSingle(),
        800,
        "translations select"
      );
      if (data?.text) {
        lruSet(key, data.text);
        return data.text;
      }
    } catch (_) {}
  }
  // provider with short retries and timeout
  const out = await attemptTranslateWithRetries(text, srcLang, dstLang);
  lruSet(key, out);
  if (supabase) {
    try {
      await withTimeout(
        supabase
          .from("translations")
          .insert({ key, src_lang: srcLang, dst_lang: dstLang, text: out }),
        800,
        "translations insert"
      );
    } catch (_) {}
  }
  return out;
}
