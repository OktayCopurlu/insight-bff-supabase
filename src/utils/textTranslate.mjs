// Lightweight text translation cache + stub provider for BFF
// - In-memory LRU-ish cache to avoid repeat work
// - Optional DB-backed cache via Supabase table `translations` (key, src_lang, dst_lang, text)

import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { generatePlain, getModelId } from "./gemini.mjs";

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

// Lightweight in-process metrics for observability
export const translateMetrics = {
  providerCalls: 0,
  providerErrors: 0,
  cacheHits: 0,
  cacheMisses: 0,
  dbHits: 0,
  dbWrites: 0,
  latencyMs: { last: 0, avg: 0, total: 0, count: 0 },
};
function _recordLatency(ms) {
  translateMetrics.latencyMs.last = ms;
  translateMetrics.latencyMs.total += ms;
  translateMetrics.latencyMs.count += 1;
  translateMetrics.latencyMs.avg = Math.round(
    translateMetrics.latencyMs.total / translateMetrics.latencyMs.count
  );
}

// Timeouts and retry knobs
// Slightly higher defaults to reduce spurious timeouts under load
const MT_TIMEOUT_MS = parseInt(process.env.MT_TIMEOUT_MS || "3000");
const MT_RETRIES = parseInt(process.env.MT_RETRIES || "3");
const MT_BACKOFF_MS = parseInt(process.env.MT_BACKOFF_MS || "200");
// Chunking to improve reliability for long texts
const MT_CHUNK_THRESHOLD = parseInt(process.env.MT_CHUNK_THRESHOLD || "1200");
const MT_CHUNK_MAX = parseInt(process.env.MT_CHUNK_MAX || "1600");

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

function splitIntoChunks(text, maxLen) {
  const t = String(text || "");
  if (t.length <= maxLen) return [t];
  const chunks = [];
  const sentences = t.match(/[^.!?\n]+[.!?\n]*/g) || [t];
  let buf = "";
  for (const s of sentences) {
    if ((buf + s).length > maxLen && buf) {
      chunks.push(buf);
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf) chunks.push(buf);
  // If any chunk still too large (very long sentence), hard split
  const out = [];
  for (const c of chunks) {
    if (c.length <= maxLen) out.push(c);
    else {
      for (let i = 0; i < c.length; i += maxLen)
        out.push(c.slice(i, i + maxLen));
    }
  }
  return out;
}

// Normalize language tags and map to provider-appropriate targets
function baseLang(tag) {
  return (String(tag || "").split("-")[0] || "").toLowerCase();
}
const langName = (b) =>
  ({
    en: "English",
    de: "German",
    tr: "Turkish",
    fr: "French",
    es: "Spanish",
    it: "Italian",
    ar: "Arabic",
    ru: "Russian",
    ja: "Japanese",
    zh: "Chinese",
    pt: "Portuguese",
    nl: "Dutch",
    pl: "Polish",
  }[b] || b);

function providerTarget(dstLang) {
  // For Gemini, prefer human-readable language names and ignore region
  return langName(baseLang(dstLang));
}

// Gemini client via centralized helper (@google/genai)
const GEMINI_MODEL =
  process.env.LLM_MODEL || process.env.GEMINI_MODEL || "gemini-1.5-flash";
const HAS_GEMINI = !!(process.env.LLM_API_KEY || process.env.GEMINI_API_KEY);

async function translateViaProvider(text, srcLang, dstLang) {
  if (!HAS_GEMINI) throw new Error("Gemini API key missing");
  const modelId = getModelId(GEMINI_MODEL);
  const prompt = `Translate the following text from ${
    srcLang || "auto"
  } to ${providerTarget(
    dstLang
  )}. Return only the translation with no extra words or quotes.\n\n${text}`;
  const { text: outText } = await generatePlain(prompt, {
    model: modelId,
    temperature: 0,
    maxOutputTokens: 512,
  });
  const out = outText || "";
  if (!out) throw new Error("Gemini no translation");
  return out;
}

function availableProviders() {
  // Single provider: Gemini only
  return HAS_GEMINI ? ["gemini"] : [];
}

async function attemptTranslateWithRetries(text, srcLang, dstLang) {
  let lastErr = null;
  const providers = availableProviders();
  if (!providers.length) {
    const marker =
      process.env.BFF_TRANSLATION_TAG === "off" ? "" : " [translated]";
    return text + marker;
  }
  // Single-provider retry loop (Gemini)
  for (let i = 0; i <= MT_RETRIES; i++) {
    try {
      const t0 = Date.now();
      translateMetrics.providerCalls += 1;
      const out = await withTimeout(
        translateViaProvider(text, srcLang, dstLang),
        MT_TIMEOUT_MS,
        "translate provider (gemini)"
      );
      _recordLatency(Date.now() - t0);
      try {
        console.info("metric: provider.call", {
          latency_ms: translateMetrics.latencyMs.last,
        });
      } catch (_) {}
      return out;
    } catch (e) {
      lastErr = e;
      if (i < MT_RETRIES) await sleep(MT_BACKOFF_MS * (i + 1));
    }
  }
  translateMetrics.providerErrors += 1;
  const marker =
    process.env.BFF_TRANSLATION_TAG === "off" ? "" : " [translated]";

  return text + marker;
}

export async function translateTextCached(text, { srcLang = "auto", dstLang }) {
  if (!text || !dstLang) return text;
  if (text.length < 2) return text;
  // Normalize destination to its base to improve cache reuse across regional variants
  const cacheDst = baseLang(dstLang) || dstLang;
  const key = keyFor(text, srcLang, cacheDst);
  // memory
  if (cache.has(key)) {
    translateMetrics.cacheHits += 1;
    try {
      console.debug("metric: provider.cache_hit", { key });
    } catch (_) {}
    return cache.get(key);
  }
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
        translateMetrics.dbHits += 1;
        lruSet(key, data.text);
        try {
          console.debug("metric: provider.db_hit", { key });
        } catch (_) {}
        return data.text;
      }
    } catch (_) {}
  }
  translateMetrics.cacheMisses += 1;
  // Chunk if long to reduce provider timeouts
  let out;
  if (text.length >= MT_CHUNK_THRESHOLD) {
    const parts = splitIntoChunks(text, MT_CHUNK_MAX);
    const translatedParts = [];
    for (const part of parts) {
      const partKey = keyFor(part, srcLang, cacheDst);
      if (cache.has(partKey)) {
        translateMetrics.cacheHits += 1;
        try {
          console.debug("metric: provider.cache_hit", { key: partKey });
        } catch (_) {}
        translatedParts.push(cache.get(partKey));
        continue;
      }
      let translated = await attemptTranslateWithRetries(
        part,
        srcLang,
        dstLang
      );
      lruSet(partKey, translated);
      // Optional: persist chunk to DB cache as well
      if (supabase) {
        try {
          await withTimeout(
            supabase.from("translations").insert({
              key: partKey,
              src_lang: srcLang,
              dst_lang: cacheDst,
              text: translated,
            }),
            800,
            "translations insert (chunk)"
          );
          translateMetrics.dbWrites += 1;
          try {
            console.debug("metric: provider.db_write", { key: partKey });
          } catch (_) {}
        } catch (_) {}
      }
      translatedParts.push(translated);
    }
    out = translatedParts.join("");
  } else {
    // provider with short retries and timeout
    out = await attemptTranslateWithRetries(text, srcLang, dstLang);
  }
  lruSet(key, out);
  if (supabase) {
    try {
      await withTimeout(
        supabase
          .from("translations")
          .insert({ key, src_lang: srcLang, dst_lang: cacheDst, text: out }),
        800,
        "translations insert"
      );
      translateMetrics.dbWrites += 1;
      try {
        console.debug("metric: provider.db_write", { key });
      } catch (_) {}
    } catch (_) {}
  }
  return out;
}

// NEW: single-call JSON translation for {title, summary, details}
export async function translateFieldsCached(
  fields,
  { srcLang = "auto", dstLang }
) {
  const { title = "", summary = "", details = "" } = fields || {};
  // Short-circuit when nothing to translate
  if (!title && !summary && !details) return { title, summary, details };
  const cacheDst = baseLang(dstLang) || dstLang;
  // Quick per-field cache hits
  const kTitle = title ? keyFor(title, srcLang, cacheDst) : null;
  const kSummary = summary ? keyFor(summary, srcLang, cacheDst) : null;
  const kDetails = details ? keyFor(details, srcLang, cacheDst) : null;
  const hitTitle = kTitle && cache.has(kTitle) ? cache.get(kTitle) : null;
  const hitSummary =
    kSummary && cache.has(kSummary) ? cache.get(kSummary) : null;
  const hitDetails =
    kDetails && cache.has(kDetails) ? cache.get(kDetails) : null;
  const allHit =
    (title ? !!hitTitle : true) &&
    (summary ? !!hitSummary : true) &&
    (details ? !!hitDetails : true);
  if (allHit) {
    let hits = 0;
    if (title && hitTitle) hits++;
    if (summary && hitSummary) hits++;
    if (details && hitDetails) hits++;
    translateMetrics.cacheHits += hits;
    return {
      title: hitTitle || title,
      summary: hitSummary || summary,
      details: hitDetails || details,
    };
  }
  // No provider? Fallback to per-string path
  if (!HAS_GEMINI) {
    return {
      title: title
        ? await translateTextCached(title, { srcLang, dstLang })
        : "",
      summary: summary
        ? await translateTextCached(summary, { srcLang, dstLang })
        : "",
      details: details
        ? await translateTextCached(details, { srcLang, dstLang })
        : "",
    };
  }
  // Single provider call with strict JSON output
  const modelId = getModelId(GEMINI_MODEL);
  const prompt = [
    `Translate the JSON fields from ${srcLang || "auto"} to ${providerTarget(
      dstLang
    )}.`,
    'Return ONLY minified JSON with keys "title","summary","details".',
    `Example output: {"title":"..","summary":"..","details":".."}`,
    `Input:`,
    JSON.stringify({ title, summary, details }),
  ].join("\n");
  let raw = "";
  try {
    const t0 = Date.now();
    translateMetrics.providerCalls += 1;
    const res = await withTimeout(
      generatePlain(prompt, {
        model: modelId,
        temperature: 0,
        maxOutputTokens: 1024,
      }),
      MT_TIMEOUT_MS,
      "translate fields (gemini)"
    );
    _recordLatency(Date.now() - t0);
    raw = String(res?.text || "").trim();
    try {
      console.info("metric: provider.call", {
        latency_ms: translateMetrics.latencyMs.last,
      });
    } catch (_) {}
  } catch (_) {
    // Fallback to per-string path on provider failure
    return {
      title: title
        ? await translateTextCached(title, { srcLang, dstLang })
        : "",
      summary: summary
        ? await translateTextCached(summary, { srcLang, dstLang })
        : "",
      details: details
        ? await translateTextCached(details, { srcLang, dstLang })
        : "",
    };
  }
  const jsonStr = raw.replace(/`json|`/g, "").trim();
  let obj = {};
  try {
    obj = JSON.parse(jsonStr);
  } catch (_) {
    // Provider returned non-JSON — fallback per-string
    return {
      title: title
        ? await translateTextCached(title, { srcLang, dstLang })
        : "",
      summary: summary
        ? await translateTextCached(summary, { srcLang, dstLang })
        : "",
      details: details
        ? await translateTextCached(details, { srcLang, dstLang })
        : "",
    };
  }
  const out = {
    title: String(obj.title ?? "").trim() || title,
    summary: String(obj.summary ?? "").trim() || summary,
    details: String(obj.details ?? "").trim() || details,
  };
  // Persist to caches and optional DB cache per field
  const items = [
    [kTitle, out.title, title],
    [kSummary, out.summary, summary],
    [kDetails, out.details, details],
  ];
  for (const [k, translated, original] of items) {
    if (!original || !k) continue;
    lruSet(k, translated);
    if (supabase) {
      try {
        await withTimeout(
          supabase.from("translations").insert({
            key: k,
            src_lang: srcLang,
            dst_lang: cacheDst,
            text: translated,
          }),
          800,
          "translations insert (fields)"
        );
        try {
          console.debug("metric: provider.db_write", { key: k });
        } catch (_) {}
      } catch (_) {}
    }
  }
  return out;
}
