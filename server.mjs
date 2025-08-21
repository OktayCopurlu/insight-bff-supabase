import express from "express";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import {
  normalizeBcp47 as nBcp47,
  pickFromAcceptLanguage as pickAL,
  isRtlLang as _isRtl,
  dirFor as _dirFor,
} from "./src/utils/lang.mjs";
import {
  translateTextCached,
  translateFieldsCached,
  translateMetrics,
} from "./src/utils/textTranslate.mjs";
import {
  generateWithSearch,
  extractGroundingLinks,
} from "./src/utils/gemini.mjs";

// Load .env manually (simple parser) if not already loaded
(function loadEnv() {
  const p = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
})();

const PORT = process.env.PORT || 4000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // server only
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});
const app = express();
app.use(express.json({ limit: "1mb" }));
// Basic CORS (uses ALLOWED_ORIGINS env or *)
const allowed = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allow = allowed.includes("*") || (origin && allowed.includes(origin));
  if (allow && origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (allowed.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "false");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------- Language helpers (BCP-47 negotiation + metadata) ----------
const normalizeBcp47 = nBcp47;
const pickFromAcceptLanguage = pickAL;

function negotiateLanguage(req) {
  // Priority: ?lang > (future user profile) > Accept-Language > en
  const q = normalizeBcp47(req.query.lang);
  if (q) return q;
  const h = pickFromAcceptLanguage(req.headers["accept-language"]);
  return h || "en";
}

const isRtlLang = _isRtl;

function setLangHeaders(res, lang) {
  res.setHeader("Content-Language", lang);
  res.setHeader("Content-Direction", isRtlLang(lang) ? "rtl" : "ltr");
}

// Wrap thenable with a timeout; works with Supabase query builders
function withTimeout(promiseLike, ms, label = "operation") {
  let to;
  const p = Promise.resolve(promiseLike);
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

// Minimal HTML entity decoder for display hygiene
function decodeHtmlEntities(text) {
  if (text == null) return "";
  let s = String(text);
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    try {
      return String.fromCodePoint(parseInt(hex, 16));
    } catch {
      return _;
    }
  });
  s = s.replace(/&#([0-9]+);/g, (_, dec) => {
    try {
      return String.fromCodePoint(parseInt(dec, 10));
    } catch {
      return _;
    }
  });
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// Removed: legacy /articles demo fallback and routes

// Light ID generator for demo entities
function genId(prefix = "id_") {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}`;
}

// In-memory stores for demo endpoints
const quizzes = new Map();
const coverageStore = new Map();
const chats = new Map();
const tokens = new Map();
const users = [];
const interactions = [];

// --------------- Lightweight BFF metrics ---------------
const bffMetrics = {
  service: "insight-bff",
  feed: { requests: 0, errors: 0 },
  cluster: { requests: 0, errors: 0 },
  config: { requests: 0, errors: 0 },
  batch: {
    requests: 0,
    succeeded: 0,
    failed: 0,
    limited: 0,
  },
};

app.get("/metrics", (_req, res) => {
  res.json({ ...bffMetrics, translate: translateMetrics });
});

// Lightweight health check for smoke tests and uptime probes
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "insight-bff",
    time: new Date().toISOString(),
  });
});

// -------------------- Article endpoints --------------------
// GET /article/:id -> returns combined fields from articles + articles_translations
app.get("/article/:id", langMiddleware, async (req, res) => {
  const target = req.lang;
  const base = (t) => (t || "").split("-")[0].toLowerCase();
  try {
    const { id } = req.params;
    // 1) Fetch base article for shared fields and source language
    const { data: art, error } = await withTimeout(
      supabase
        .from("articles")
        .select(
          "id,lang,image_url,url,canonical_url,published_at,source_id,title,snippet"
        )
        .eq("id", id)
        .maybeSingle(),
      2000,
      "article base"
    );
    if (error) throw error;
    if (!art) return res.status(404).json({ error: "not_found" });

    const src = normalizeBcp47(art.lang || "");
    const baseTarget = base(target);

    // 2) Prefer exact translation row, then base(target), then source language row
    const tryGet = async (lang) => {
      const { data } = await withTimeout(
        supabase
          .from("articles_translations")
          .select("dst_lang,headline,summary_ai,text_html")
          .eq("article_id", id)
          .eq("dst_lang", lang)
          .maybeSingle(),
        1500,
        `translation ${lang}`
      );
      return data || null;
    };
    let tr = await tryGet(target);
    if (!tr && baseTarget && baseTarget !== target)
      tr = await tryGet(baseTarget);
    if (!tr && src) tr = await tryGet(base(src));
    // Last resort: any translation row
    if (!tr) {
      try {
        const { data } = await withTimeout(
          supabase
            .from("articles_translations")
            .select("dst_lang,headline,summary_ai,text_html")
            .eq("article_id", id)
            .limit(1),
          1000,
          "translation any"
        );
        tr = (data && data[0]) || null;
      } catch (_) {}
    }
    if (!tr) return res.status(404).json({ error: "no_translation" });

    const used = normalizeBcp47(tr.dst_lang || src || target);
    const isTranslated = base(used) !== base(src);
    const result = {
      id: art.id,
      language: used,
      headline: decodeHtmlEntities(tr.headline || art.title || ""),
      summary: decodeHtmlEntities(tr.summary_ai || art.snippet || ""),
      body: tr.text_html || "",
      url: art.canonical_url || art.url,
      canonical_url: art.canonical_url || null,
      image_url: art.image_url || null,
      published_at: art.published_at || null,
      source_id: art.source_id || null,
      dir: dirFor(used),
      is_translated: isTranslated,
      translated_from: isTranslated ? src || null : null,
    };
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: "failed_to_fetch" });
  }
});

// GET /article/:id/body?lang=xx -> returns body in requested language using translation cache when needed
app.get("/article/:id/body", langMiddleware, async (req, res) => {
  const target = req.lang;
  const base = (t) => (t || "").split("-")[0].toLowerCase();
  try {
    const { id } = req.params;
    // Base article for source language
    const { data: art, error } = await withTimeout(
      supabase.from("articles").select("id,lang").eq("id", id).maybeSingle(),
      2000,
      "article body base"
    );
    if (error) throw error;
    if (!art) return res.status(404).json({ error: "not_found" });
    const src = normalizeBcp47(art.lang || "");
    const baseTarget = base(target);

    const tryGet = async (lang) => {
      const { data } = await withTimeout(
        supabase
          .from("articles_translations")
          .select("dst_lang,text_html")
          .eq("article_id", id)
          .eq("dst_lang", lang)
          .maybeSingle(),
        1500,
        `translation body ${lang}`
      );
      return data || null;
    };

    let tr = await tryGet(target);
    if (!tr && baseTarget && baseTarget !== target)
      tr = await tryGet(baseTarget);
    if (!tr && src) tr = await tryGet(base(src));
    if (!tr) return res.status(404).json({ error: "no_translation" });

    const used = normalizeBcp47(tr.dst_lang || src || target);
    const isTranslated = base(used) !== base(src);
    res.json({
      id: art.id,
      language: used,
      body: tr.text_html || "",
      is_translated: isTranslated,
      translated_from: isTranslated ? src || null : null,
      dir: dirFor(used),
    });
  } catch (e) {
    res.status(500).json({ error: "failed_to_fetch" });
  }
});

// Simple auth middleware using in-memory token store
function authMiddleware(req, res, next) {
  try {
    const h = String(req.headers["authorization"] || "");
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: "unauthorized" });
    const token = m[1];
    const userId = tokens.get(token);
    if (!userId) return res.status(401).json({ error: "unauthorized" });
    req.userId = userId;
    next();
  } catch (_) {
    return res.status(401).json({ error: "unauthorized" });
  }
}

// Language middleware: negotiates lang and sets response headers
function langMiddleware(req, res, next) {
  const lang = negotiateLanguage(req);
  req.lang = lang;
  setLangHeaders(res, lang);
  next();
}

// Removed: legacy /articles routes and feature flag

// CHAT endpoints
app.post("/cluster/:id/chat", langMiddleware, async (req, res) => {
  const { id } = req.params;
  const target = req.lang;
  const { message, chatHistory = [], userId = null } = req.body || {};
  if (!message) return res.status(400).json({ error: "message required" });
  // Very light grounding: ensure cluster exists
  const { data: cluster } = await supabase
    .from("clusters")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (!cluster) return res.status(404).json({ error: "Cluster not found" });

  // Append user message (store ephemeral in-memory only)
  const key = `cluster:${id}`;
  const history = chats.get(key) || [];
  history.push({
    id: genId("m_"),
    type: "user",
    content: message,
    timestamp: new Date().toISOString(),
    userId,
  });

  // Try real LLM reply using Gemini when API key is available; fallback to demo template otherwise
  let reply;
  let searchCitations = [];
  const hasGemini = !!(process.env.LLM_API_KEY || process.env.GEMINI_API_KEY);
  if (hasGemini) {
    try {
      // Gather brief cluster context in target language
      const ensured = await ensureClusterTextInLang(cluster.id, target);
      // Fetch recent timeline updates (translate on the fly like in GET /cluster/:id)
      const { data: updates } = await withTimeout(
        supabase
          .from("cluster_updates")
          .select("id,claim,summary,source_id,lang,happened_at,created_at")
          .eq("cluster_id", id)
          .order("happened_at", { ascending: false })
          .limit(5),
        2000,
        "chat timeline"
      );
      const upTranslated = [];
      for (const u of updates || []) {
        const baseText = u.summary || u.claim || "";
        const src = normalizeBcp47(u.lang || "");
        const base = (t) => (t || "").split("-")[0].toLowerCase();
        const needs = src && base(src) !== base(target);
        let text = baseText;
        if (needs) {
          try {
            text = await translateTextCached(baseText, {
              srcLang: src,
              dstLang: target,
            });
          } catch (_) {
            const t =
              process.env.BFF_TRANSLATION_TAG === "off" ? "" : " [translated]";
            text = baseText + t;
          }
        }
        upTranslated.push({
          id: u.id,
          text,
          happened_at: u.happened_at || u.created_at,
        });
      }
      const citations = await getClusterCitations(id, 3);

      // Compose a concise, grounded prompt and ask Gemini to answer in target language
      const instructions = [
        `You are a helpful news assistant. Answer in ${target} only.`,
        `Be concise (<= 150 words) unless the user asks for more.`,
        `Use the provided context and any grounded web results to answer and cite sources.`,
        `Do not mention aggregator sources (e.g., Newsdata.io).`,
        `If context is insufficient, say you don't have enough info; do not claim you cannot search.`,
        `Do not invent facts. Prefer citing URLs when available.`,
      ].join("\n");
      const summaryPart = ensured?.ai_summary
        ? `Summary: ${ensured.ai_summary}`
        : "";
      const timelinePart = upTranslated.length
        ? `Timeline:\n- ${upTranslated.map((u) => u.text).join("\n- ")}`
        : "";
      const sourcesPart = citations.length
        ? `Sources:\n- ${citations
            .map((c) => `${c.source_name || "Source"}: ${c.title}`)
            .join("\n- ")}`
        : "";
      const context = [summaryPart, timelinePart, sourcesPart]
        .filter(Boolean)
        .join("\n\n");

      const prompt = [
        instructions,
        `Question: ${message}`,
        context ? `\n\nContext:\n${context}` : "",
      ].join("\n\n");
      const resp = await withTimeout(
        generateWithSearch(prompt, {
          useGoogleSearch: true,
          // Do not set dynamicRetrieval when googleSearch is on
          model: process.env.LLM_MODEL || process.env.GEMINI_MODEL,
          temperature: 0.4,
        }),
        10000,
        "gemini chat"
      );
      let txt = resp?.text || "";
      // Sanitize bracketed aggregator mentions like [Newsdata.io ...]
      txt = txt.replace(/\[[^\]]*newsdata[^\]]*\]/gi, "");
      reply = (txt || "").trim();
      if (!reply) throw new Error("empty gemini reply");
      // Attach grounded links into citations when available
      try {
        const links = extractGroundingLinks(resp?.grounding);
        if (Array.isArray(links) && links.length) {
          searchCitations = links.slice(0, 5).map((u, i) => ({
            id: `g${i + 1}`,
            title: null,
            url: u,
            source_id: null,
            source_name: "Google Search",
          }));
        }
        // Surface grounding mode for debugging
        if (resp?.mode) res.setHeader("X-Grounding-Mode", resp.mode);
      } catch (_) {}
    } catch (e) {
      console.warn("[chat] gemini failed, falling back to demo:", e.message);
    }
  }
  if (!reply) {
    // Demo fallback
    if (target?.startsWith("en")) reply = `Answer (demo): ${message}`;
    else if (target?.startsWith("de")) reply = `Antwort (Demo): ${message}`;
    else if (target?.startsWith("tr")) reply = `Yanıt (demo): ${message}`;
    else if (target?.startsWith("ar")) reply = `رد (تجريبي): ${message}`;
    else reply = `Answer (demo): ${message}`;
  }

  history.push({
    id: genId("m_"),
    type: "ai",
    content: reply,
    timestamp: new Date().toISOString(),
  });
  chats.set(key, history);
  // Include top citations for grounding (include any search-grounded links from earlier if present)
  let finalCitations = [];
  try {
    finalCitations = await getClusterCitations(id, 3);
  } catch (_) {}
  // The earlier block may have set search-grounded links
  if (Array.isArray(searchCitations) && searchCitations.length) {
    // Prepend grounded links; avoid duplicates by URL
    const seen = new Set();
    const merged = [];
    for (const c of searchCitations) {
      const k = c.url || c.id;
      if (k && !seen.has(k)) {
        seen.add(k);
        merged.push(c);
      }
    }
    for (const c of finalCitations) {
      const k = c.url || c.id;
      if (k && !seen.has(k)) {
        seen.add(k);
        merged.push(c);
      }
    }
    finalCitations = merged;
  }
  res.json({ messages: history, citations: finalCitations });
});
app.get("/cluster/:id/chat", (req, res) => {
  const key = `cluster:${req.params.id}`;
  res.json({ messages: chats.get(key) || [] });
});

// AUTH endpoints
app.post("/auth/register", (req, res) => {
  const { email, password, name, preferences } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: "email and password required" });
  if (users.find((u) => u.email === email))
    return res.status(400).json({ error: "Email already registered" });
  const now = new Date().toISOString();
  const user = {
    id: genId("usr_"),
    email,
    password,
    name: name || email.split("@")[0],
    preferences: preferences || {
      topics: [],
      languages: ["en"],
      readingLevel: "intermediate",
      audioPreferences: false,
      biasAnalysis: true,
      notifications: false,
    },
    onboarding_complete: false,
    created_at: now,
    updated_at: now,
  };
  users.push(user);
  const token = genId("tok_");
  tokens.set(token, user.id);
  res.json({ user: { ...user, password: undefined }, token });
});
app.post("/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  const user = users.find((u) => u.email === email && u.password === password);
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  const token = genId("tok_");
  tokens.set(token, user.id);
  res.json({ user: { ...user, password: undefined }, token });
});
app.get("/auth/profile", authMiddleware, (req, res) => {
  const user = users.find((u) => u.id === req.userId);
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json({ ...user, password: undefined });
});
app.put("/auth/preferences", authMiddleware, (req, res) => {
  const user = users.find((u) => u.id === req.userId);
  if (!user) return res.status(404).json({ error: "Not found" });
  user.preferences = { ...user.preferences, ...(req.body?.preferences || {}) };
  user.updated_at = new Date().toISOString();
  res.json({ ...user, password: undefined });
});

// Interaction tracking
app.post("/interaction", (req, res) => {
  const { articleId, interactionType, metadata } = req.body || {};
  interactions.push({
    id: genId("int_"),
    ts: Date.now(),
    articleId,
    interactionType,
    metadata,
  });
  res.json({ success: true });
});

// Robust listen with auto-increment fallback to avoid EADDRINUSE during dev
function startServer(startPort, attempts = 5) {
  const portNum = parseInt(startPort, 10);
  const server = app.listen(portNum, () => {
    console.log(`BFF server listening on http://localhost:${portNum}`);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && attempts > 0) {
      const next = portNum + 1;
      console.warn(
        `Port ${portNum} in use, retrying on ${next} (remaining attempts: ${
          attempts - 1
        })`
      );
      setTimeout(() => startServer(next, attempts - 1), 300);
    } else {
      console.error("Failed to bind server port:", err);
      process.exit(1);
    }
  });
}

// Only auto-start the server outside of test environments
if (
  process.env.NODE_ENV !== "test" &&
  process.env.BFF_AUTO_LISTEN !== "false"
) {
  startServer(PORT);
}

// Export the Express app for testing
export { app };

// -------------------- Multilingual cluster-first endpoints --------------------

// Lightweight background queue for persisting translations without blocking responses
const PERSIST_MAX_CONCURRENCY = parseInt(
  process.env.PERSIST_MAX_CONCURRENCY || "1"
);
const _persistQueue = [];
let _persistActive = 0;
function _enqueuePersist(fn) {
  _persistQueue.push(fn);
  // Kick the drain on next tick
  if (typeof setImmediate === "function") setImmediate(_drainPersistQueue);
  else setTimeout(_drainPersistQueue, 0);
}
async function _drainPersistQueue() {
  if (_persistActive >= PERSIST_MAX_CONCURRENCY) return;
  const job = _persistQueue.shift();
  if (!job) return;
  _persistActive++;
  try {
    await job();
  } catch (e) {
    console.warn("persist job failed:", e?.message || e);
  } finally {
    _persistActive--;
    if (_persistQueue.length) setTimeout(_drainPersistQueue, 50);
  }
}

// Helper: get or translate cluster AI into target language and persist idempotently
async function ensureClusterTextInLang(clusterId, targetLang) {
  const base = (t) => (t || "").split("-")[0].toLowerCase();
  const baseTarget = base(targetLang);
  // 1) Try target language first (include created_at for staleness check)
  const { data: existingTarget, error: targetErr } = await supabase
    .from("cluster_ai")
    .select(
      "id,lang,ai_title,ai_summary,ai_details,is_current,created_at,model"
    )
    .eq("cluster_id", clusterId)
    .eq("lang", targetLang)
    .eq("is_current", true)
    .maybeSingle();
  if (targetErr) throw targetErr;
  // Fallback to base language row if exact regional row is missing
  let existingBase = null;
  if (!existingTarget && baseTarget && baseTarget !== targetLang) {
    try {
      const { data: eb } = await supabase
        .from("cluster_ai")
        .select(
          "id,lang,ai_title,ai_summary,ai_details,is_current,created_at,model"
        )
        .eq("cluster_id", clusterId)
        .eq("lang", baseTarget)
        .eq("is_current", true)
        .maybeSingle();
      existingBase = eb || null;
    } catch (_) {}
  }

  // 2) Find a pivot/current row (any lang, prefer en) and include created_at
  const { data: currents, error: curErr } = await supabase
    .from("cluster_ai")
    .select(
      "id,lang,ai_title,ai_summary,ai_details,is_current,created_at,model"
    )
    .eq("cluster_id", clusterId)
    .eq("is_current", true);
  if (curErr) throw curErr;
  if (!currents || !currents.length) return null;
  const pivot = currents.find((r) => r.lang === "en") || currents[0];
  const pivotSig = crypto
    .createHash("sha1")
    .update(
      `${pivot.ai_title || ""}\n${pivot.ai_summary || ""}\n${
        pivot.ai_details || ""
      }`
    )
    .digest("hex")
    .slice(0, 10);

  // If target exists, check staleness vs pivot (created_at)
  const useRow = existingTarget || existingBase || null;
  if (useRow) {
    try {
      const tCreated = Date.parse(useRow.created_at || 0) || 0;
      const pCreated = Date.parse(pivot.created_at || 0) || 0;
      // Also detect legacy rows where the title wasn't translated (title equals pivot title but languages differ)
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const needsRefreshTitle =
        norm(useRow.ai_title) === norm(pivot.ai_title) &&
        (useRow.lang || "") !== (pivot.lang || "");
      const needsRefreshSummary =
        norm(useRow.ai_summary) === norm(pivot.ai_summary) &&
        (useRow.lang || "") !== (pivot.lang || "");
      const needsRefreshDetails =
        norm(useRow.ai_details) === norm(pivot.ai_details) &&
        (useRow.lang || "") !== (pivot.lang || "");
      // Detect stub marker from earlier fallback translations
      const stubMarker = " [translated]";
      const hasStubMarker =
        (useRow.ai_title || "").includes(stubMarker) ||
        (useRow.ai_summary || "").includes(stubMarker) ||
        (useRow.ai_details || "").includes(stubMarker);
      // If existing model encodes the same pivot signature, prefer it as fresh
      const modelTag = (useRow.model || "").toString();
      const samePivotSig =
        (useRow.pivot_hash && useRow.pivot_hash === pivotSig) ||
        modelTag.includes(`#ph=${pivotSig}`);
      const isOrigBody = modelTag.includes("#body=orig");
      if (
        (samePivotSig || tCreated >= pCreated) &&
        !needsRefreshTitle &&
        !needsRefreshSummary &&
        !needsRefreshDetails &&
        !hasStubMarker
      ) {
        // Special-case: when the current row carries original body (#body=orig)
        // and caller requests the same language (e.g., en), create and persist
        // a translated current row for that language so DB holds the translation.
        if (isOrigBody && base(useRow.lang) === baseTarget) {
          const translated = await translateNow(pivot, "auto", targetLang);
          // Flip existing current rows for this lang to false (including the orig-body row)
          try {
            await supabase
              .from("cluster_ai")
              .update({ is_current: false })
              .eq("cluster_id", clusterId)
              .eq("lang", targetLang)
              .eq("is_current", true);
          } catch (_) {}
          // Insert the translated row as current, tagging pivot hash
          try {
            await supabase.from("cluster_ai").insert({
              cluster_id: clusterId,
              lang: targetLang,
              ai_title: translated.ai_title,
              ai_summary: translated.ai_summary,
              ai_details: translated.ai_details,
              model: `bff-stub#ph=${pivotSig}`,
              pivot_hash: pivotSig,
              is_current: true,
            });
          } catch (insErr) {
            await supabase.from("cluster_ai").insert({
              cluster_id: clusterId,
              lang: targetLang,
              ai_title: translated.ai_title,
              ai_summary: translated.ai_summary,
              ai_details: translated.ai_details,
              model: `bff-stub#ph=${pivotSig}`,
              is_current: true,
            });
          }
          return {
            ...translated,
            is_translated: true,
            translated_from: pivot.lang,
          };
        }
        // Fresh enough
        return {
          ...useRow,
          is_translated: false,
          translated_from: null,
        };
      }
      // Stale or legacy untranslated title: re-translate from pivot and replace current
      const translated = await translateNow(pivot, pivot.lang, targetLang);
      // Best-effort swap: mark old false, insert new true (avoid unique violation)
      await supabase
        .from("cluster_ai")
        .update({ is_current: false })
        .eq("id", useRow.id);
      try {
        await supabase.from("cluster_ai").insert({
          cluster_id: clusterId,
          lang: targetLang,
          ai_title: translated.ai_title,
          ai_summary: translated.ai_summary,
          ai_details: translated.ai_details,
          model: `bff-stub#ph=${pivotSig}`,
          pivot_hash: pivotSig,
          is_current: true,
        });
      } catch (insErr) {
        // Fallback when pivot_hash column doesn't exist
        await supabase.from("cluster_ai").insert({
          cluster_id: clusterId,
          lang: targetLang,
          ai_title: translated.ai_title,
          ai_summary: translated.ai_summary,
          ai_details: translated.ai_details,
          model: `bff-stub#ph=${pivotSig}`,
          is_current: true,
        });
      }
      return {
        ...translated,
        is_translated: true,
        translated_from: pivot.lang,
      };
    } catch (e) {
      console.warn("Refresh translated cluster_ai failed:", e.message);
      return { ...useRow, is_translated: false, translated_from: null };
    }
  }

  // 3) No target: translate now (stub MT for demo; replace with provider). Idempotent insert.
  const translated = await translateNow(pivot, pivot.lang, targetLang);
  try {
    // Check again to avoid dupes in races
    const { data: checkAgain } = await supabase
      .from("cluster_ai")
      .select("id")
      .eq("cluster_id", clusterId)
      .eq("lang", targetLang)
      .eq("is_current", true)
      .maybeSingle();
    if (!checkAgain) {
      try {
        await supabase.from("cluster_ai").insert({
          cluster_id: clusterId,
          lang: targetLang,
          ai_title: translated.ai_title,
          ai_summary: translated.ai_summary,
          ai_details: translated.ai_details,
          model: `bff-stub#ph=${pivotSig}`,
          pivot_hash: pivotSig,
          is_current: true,
        });
      } catch (insErr) {
        await supabase.from("cluster_ai").insert({
          cluster_id: clusterId,
          lang: targetLang,
          ai_title: translated.ai_title,
          ai_summary: translated.ai_summary,
          ai_details: translated.ai_details,
          model: `bff-stub#ph=${pivotSig}`,
          is_current: true,
        });
      }
    }
  } catch (e) {
    // Non-fatal: we still return the translated text
    console.warn("Persist translated cluster_ai failed:", e.message);
  }
  return { ...translated, is_translated: true, translated_from: pivot.lang };
}

async function translateNow(pivot, srcLang, dstLang) {
  const s = normalizeBcp47(srcLang);
  const d = normalizeBcp47(dstLang);
  if (!d || s === d) return { ...pivot };
  // Short-circuit if base language matches (e.g., en vs en-US)
  const base = (t) => (t || "").split("-")[0].toLowerCase();
  const isOrigBody = (pivot.model || "").includes("#body=orig");
  if (!isOrigBody && base(s) === base(d)) return { ...pivot };
  // Prefer single-call translation to reduce provider calls; fallback to per-field helper internally
  const { title, summary, details } = await translateFieldsCached(
    {
      title: pivot.ai_title || "",
      summary: pivot.ai_summary || "",
      details: pivot.ai_details || pivot.ai_summary || "",
    },
    { srcLang: isOrigBody ? "auto" : s, dstLang: d }
  );
  const clean = (v) => (v || "").replace(/\s+$/g, "");
  return {
    id: pivot.id,
    lang: d,
    ai_title: clean(title),
    ai_summary: clean(summary),
    ai_details: clean(details),
    is_current: true,
  };
}

const dirFor = _dirFor;

// In-process deduplication for ensureClusterTextInLang calls
const _ensureInflight = new Map(); // key -> Promise
function ensureClusterTextInLangDedup(clusterId, targetLang) {
  const key = `${clusterId}|${targetLang}`;
  const existing = _ensureInflight.get(key);
  if (existing) return existing;
  const p = ensureClusterTextInLang(clusterId, targetLang)
    .catch((e) => {
      throw e;
    })
    .finally(() => {
      _ensureInflight.delete(key);
    });
  _ensureInflight.set(key, p);
  return p;
}

// Non-blocking fetch for feed: return quickly using existing cached target text when available;
// otherwise return pivot text immediately and schedule persistence/translation in background.
async function getClusterTextInLangNonBlocking(clusterId, targetLang) {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const base = (t) => (t || "").split("-")[0].toLowerCase();
  // 1) Try target language current row
  let existingTarget = null;
  try {
    const { data } = await withTimeout(
      supabase
        .from("cluster_ai")
        .select(
          "id,lang,ai_title,ai_summary,ai_details,is_current,created_at,model,pivot_hash"
        )
        .eq("cluster_id", clusterId)
        .eq("lang", targetLang)
        .eq("is_current", true)
        .maybeSingle(),
      1000,
      "cluster_ai target (fast)"
    );
    existingTarget = data || null;
  } catch (_) {}

  // 2) Get pivot/current rows to decide freshness and to fallback
  let pivot = null;
  try {
    const { data: currents } = await withTimeout(
      supabase
        .from("cluster_ai")
        .select(
          "id,lang,ai_title,ai_summary,ai_details,is_current,created_at,model,pivot_hash"
        )
        .eq("cluster_id", clusterId)
        .eq("is_current", true),
      1000,
      "cluster_ai currents (fast)"
    );
    if (currents && currents.length) {
      pivot = currents.find((r) => r.lang === "en") || currents[0];
    }
  } catch (_) {}
  if (!pivot && !existingTarget) return null; // nothing to show

  // 3) If we have a target translation, use it; check staleness lightly vs pivot
  if (existingTarget && pivot) {
    const tCreated = Date.parse(existingTarget.created_at || 0) || 0;
    const pCreated = Date.parse(pivot.created_at || 0) || 0;
    const stubMarker = " [translated]";
    const hasStubMarker =
      (existingTarget.ai_title || "").includes(stubMarker) ||
      (existingTarget.ai_summary || "").includes(stubMarker) ||
      (existingTarget.ai_details || "").includes(stubMarker);
    // If stale (older than pivot) or contains stub marker, schedule a background refresh
    if (tCreated < pCreated || hasStubMarker) {
      _enqueuePersist(() =>
        ensureClusterTextInLangDedup(clusterId, targetLang)
      );
    }
    return {
      ...existingTarget,
      is_translated: base(existingTarget.lang) !== base(pivot.lang),
      translated_from:
        base(existingTarget.lang) !== base(pivot.lang) ? pivot.lang : null,
    };
  }

  // 4) No target yet: return pivot immediately (may be different language)
  const immediate = pivot || existingTarget;
  // Schedule background creation of the target language row
  _enqueuePersist(() => ensureClusterTextInLangDedup(clusterId, targetLang));
  return {
    ...immediate,
    // Keep content as-is; indicate not translated yet for this target
    is_translated: false,
    translated_from: null,
  };
}

// GET /feed?lang=de-CH&limit=...
// Helper to get best translation row for an article id with fallback
async function getBestArticleTranslation(articleId, target) {
  const base = (t) => (t || "").split("-")[0].toLowerCase();
  const baseTarget = base(target);
  const tryGet = async (lang) => {
    const { data } = await withTimeout(
      supabase
        .from("articles_translations")
        .select("dst_lang,headline,summary_ai,text_html")
        .eq("article_id", articleId)
        .eq("dst_lang", lang)
        .maybeSingle(),
      1200,
      `best tr ${lang}`
    );
    return data || null;
  };
  let tr = await tryGet(target);
  if (!tr && baseTarget && baseTarget !== target) tr = await tryGet(baseTarget);
  if (!tr) {
    try {
      const { data: any } = await withTimeout(
        supabase
          .from("articles_translations")
          .select("dst_lang,headline,summary_ai,text_html")
          .eq("article_id", articleId)
          .limit(1),
        800,
        "best tr any"
      );
      tr = (any && any[0]) || null;
    } catch (_) {}
  }
  return tr;
}

app.get("/feed", langMiddleware, async (req, res) => {
  bffMetrics.feed.requests += 1;
  const target = req.lang;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const strict = String(req.query.strict || "").toLowerCase();
  const waitTranslations = strict === "1" || strict === "true";
  const DB_T_MS = waitTranslations ? 8000 : 2000;
  const DB_T_FAST_MS = waitTranslations ? 4000 : 1500;
  const effectiveLimit = waitTranslations ? Math.min(limit, 8) : limit;
  try {
    // Pull recent articles
    const { data: arts, error } = await withTimeout(
      supabase
        .from("articles")
        .select("id,title,snippet,published_at,lang,image_url")
        .order("published_at", { ascending: false })
        .limit(effectiveLimit * 2),
      DB_T_MS,
      "articles list"
    );
    if (error) throw error;
    if (!arts || !arts.length) return res.json([]);

    const ids = arts.map((a) => a.id);
    // Preload media (first by sort_index, else any)
    let mediaByArticle = new Map();
    try {
      const { data: media } = await withTimeout(
        supabase
          .from("article_media")
          .select("article_id,url,type,sort_index")
          .in("article_id", ids.length ? ids : ["__none__"]),
        DB_T_FAST_MS,
        "article media"
      );
      const temp = new Map();
      (media || []).forEach((m) => {
        const list = temp.get(m.article_id) || [];
        list.push(m);
        temp.set(m.article_id, list);
      });
      mediaByArticle = new Map(
        [...temp.entries()].map(([aid, list]) => {
          const sorted = list.sort(
            (a, b) => (a.sort_index || 0) - (b.sort_index || 0)
          );
          const pick =
            sorted.find((x) => x.type === "thumbnail") || sorted[0] || null;
          return [aid, pick?.url || null];
        })
      );
    } catch (_) {}

    // Preload categories (use slug or name as tags)
    let catsByArticle = new Map();
    try {
      const { data: links } = await withTimeout(
        supabase
          .from("article_categories")
          .select("article_id,category_id")
          .in("article_id", ids.length ? ids : ["__none__"]),
        DB_T_FAST_MS,
        "article categories"
      );
      const catIds = [
        ...new Set((links || []).map((l) => l.category_id).filter(Boolean)),
      ];
      let map = new Map();
      if (catIds.length) {
        const { data: cats } = await withTimeout(
          supabase.from("categories").select("id,slug,name").in("id", catIds),
          DB_T_FAST_MS,
          "categories"
        );
        map = new Map((cats || []).map((c) => [c.id, c.slug || c.name]));
      }
      const agg = new Map();
      (links || []).forEach((l) => {
        const list = agg.get(l.article_id) || [];
        const tag = map.get(l.category_id);
        if (tag) list.push(tag);
        agg.set(l.article_id, list);
      });
      catsByArticle = agg;
    } catch (_) {}

    const cards = [];
    for (const a of arts.slice(0, effectiveLimit)) {
      const tr = await getBestArticleTranslation(a.id, target);
      if (!tr) {
        if (waitTranslations) continue; // skip in strict mode
        // non-strict: show placeholder with pending status
        cards.push({
          id: a.id,
          title: a.title || null,
          summary: a.snippet || null,
          language: target,
          dir: dirFor(target),
          is_translated: false,
          translated_from: null,
          image_url: mediaByArticle.get(a.id) || a.image_url || null,
          category: (catsByArticle.get(a.id) || [])[0] || "general",
          tags: catsByArticle.get(a.id) || [],
          coverage_count: 1,
          translation_status: "pending",
          published_at: a.published_at || null,
        });
        continue;
      }
      const used = normalizeBcp47(tr.dst_lang || target);
      const base = (t) => (t || "").split("-")[0].toLowerCase();
      const isTranslated = a.lang ? base(used) !== base(a.lang) : true;
      cards.push({
        id: a.id,
        title: decodeHtmlEntities(tr.headline || a.title || ""),
        summary: decodeHtmlEntities(tr.summary_ai || a.snippet || ""),
        language: used,
        dir: dirFor(used),
        is_translated: isTranslated,
        translated_from: isTranslated ? a.lang || null : null,
        image_url: mediaByArticle.get(a.id) || a.image_url || null,
        category: (catsByArticle.get(a.id) || [])[0] || "general",
        tags: catsByArticle.get(a.id) || [],
        coverage_count: 1,
        translation_status: "ready",
        published_at: a.published_at || null,
      });
    }
    res.json(cards);
  } catch (err) {
    console.error("/feed failed", err.message);
    bffMetrics.feed.errors += 1;
    res.status(500).json({ error: "Failed to load feed" });
  }
});

// GET /cluster/:id?lang=...
// Helper to collect top-N citations for a cluster
async function getClusterCitations(clusterId, n = 3) {
  try {
    const { data: arts } = await withTimeout(
      supabase
        .from("articles")
        .select("id,title,canonical_url,url,source_id,published_at")
        .eq("cluster_id", clusterId)
        .order("published_at", { ascending: false })
        .limit(n),
      2000,
      "cluster citations"
    );
    const srcIds = [
      ...new Set((arts || []).map((a) => a.source_id).filter(Boolean)),
    ];
    let srcMap = new Map();
    if (srcIds.length) {
      const { data: srcs } = await withTimeout(
        supabase.from("sources").select("id,name").in("id", srcIds),
        1500,
        "citation sources"
      );
      srcMap = new Map((srcs || []).map((s) => [s.id, s.name]));
    }
    return (arts || []).map((a) => ({
      id: a.id,
      title: a.title,
      url: a.canonical_url || a.url,
      source_id: a.source_id,
      source_name: a.source_id ? srcMap.get(a.source_id) || null : null,
    }));
  } catch (e) {
    console.warn("getClusterCitations failed:", e.message);
    return [];
  }
}

app.get("/cluster/:id", langMiddleware, async (req, res) => {
  bffMetrics.cluster.requests += 1;
  const target = req.lang;
  const { id } = req.params;
  try {
    const t0 = Date.now();
    // Base cluster
    const { data: cluster, error: clErr } = await withTimeout(
      supabase
        .from("clusters")
        .select("id,rep_article")
        .eq("id", id)
        .maybeSingle(),
      2000,
      "cluster base"
    );
    if (clErr || !cluster) return res.status(404).json({ error: "Not found" });

    const ensured = await ensureClusterTextInLang(cluster.id, target);

    if (!ensured) return res.status(404).json({ error: "No text for cluster" });

    // Timeline (translate on the fly; do not persist for now)
    const { data: updates } = await withTimeout(
      supabase
        .from("cluster_updates")
        .select("id,claim,summary,source_id,lang,happened_at,created_at")
        .eq("cluster_id", id)
        .order("happened_at", { ascending: false }),
      2000,
      "cluster timeline"
    );
    const upTranslated = [];
    for (const u of updates || []) {
      const baseText = u.summary || u.claim || "";
      const src = normalizeBcp47(u.lang || "");
      const base = (t) => (t || "").split("-")[0].toLowerCase();
      const needs = src && base(src) !== base(target);
      let text = baseText;
      if (needs) {
        try {
          text = await translateTextCached(baseText, {
            srcLang: src,
            dstLang: target,
          });
        } catch (_) {
          const t =
            process.env.BFF_TRANSLATION_TAG === "off" ? "" : " [translated]";
          text = baseText + t;
        }
      }
      upTranslated.push({
        id: u.id,
        text,
        language: needs ? target : src || target,
        translated_from: needs ? src : null,
        happened_at: u.happened_at || u.created_at,
        source_id: u.source_id,
      });
    }

    // Coverage count
    let coverage_count = 1;
    try {
      const { data: arts } = await withTimeout(
        supabase.from("articles").select("id").eq("cluster_id", id),
        1500,
        "cluster coverage count"
      );
      coverage_count = (arts || []).length || 1;
    } catch (_) {}

    // Rep thumbnail
    let image_url = null;
    try {
      const { data: link } = await withTimeout(
        supabase
          .from("article_media")
          .select("media_id")
          .eq("article_id", cluster.rep_article)
          .eq("role", "thumbnail")
          .limit(1),
        1500,
        "cluster rep thumb link"
      );
      if (link && link[0]) {
        const { data: asset } = await withTimeout(
          supabase
            .from("media_assets")
            .select("url")
            .eq("id", link[0].media_id)
            .maybeSingle(),
          1500,
          "cluster rep thumb asset"
        );
        image_url = asset?.url || null;
      }
    } catch (_) {}

    // Citations (top 3)
    const citations = await getClusterCitations(id, 3);

    // Compose richer details when ai_details is missing or too short
    const cleanTitle = decodeHtmlEntities(ensured.ai_title || "");
    const cleanSummary = decodeHtmlEntities(ensured.ai_summary || "");
    const cleanDetails = decodeHtmlEntities(ensured.ai_details || "");
    const strip = (s) => (s || "").replace(/\s+/g, " ").trim();
    const sameAsSummary =
      strip(cleanDetails) && strip(cleanSummary)
        ? strip(cleanDetails) === strip(cleanSummary)
        : false;
    let composedDetails = cleanDetails || "";
    if (!composedDetails || composedDetails.length < 240 || sameAsSummary) {
      const parts = [];
      if (cleanSummary) parts.push(cleanSummary.trim());
      if (upTranslated && upTranslated.length) {
        const top = upTranslated.slice(0, 5); // cap to avoid very long responses
        const bullets = top.map((u) => `• ${u.text}`).join("\n");
        parts.push("\nTimeline updates:\n" + bullets);
      }
      if (citations && citations.length) {
        const cites = citations
          .map((c) => `• ${c.source_name || "Source"}: ${c.title}`)
          .join("\n");
        parts.push("\nSources:\n" + cites);
      }
      composedDetails = decodeHtmlEntities(parts.filter(Boolean).join("\n\n"));
    }

    res.json({
      id: cluster.id,
      title: cleanTitle,
      summary: cleanSummary,
      ai_details: composedDetails,
      language: target,
      is_translated: ensured.is_translated || false,
      translated_from: ensured.translated_from || null,
      dir: dirFor(target),
      image_url,
      coverage_count,
      timeline: upTranslated,
      citations,
    });
    console.log(
      `[BFF:/cluster] id=${id} updates=${(updates || []).length} citations=${
        citations.length
      } in ${Date.now() - t0}ms lang=${target}`
    );
  } catch (err) {
    console.error("/cluster/:id failed", err.message);
    bffMetrics.cluster.errors += 1;
    res.status(500).json({ error: "Failed to load cluster" });
  }
});

// (health route already defined above)

// -------------------- Market config + batch translation endpoints --------------------

// GET /config?market=CH
app.get("/config", async (req, res) => {
  bffMetrics.config.requests += 1;
  // Build a safe fallback config when DB isn't ready or table is missing
  const buildFallback = (requested) => {
    const fallbackMarket =
      String(requested || process.env.DEFAULT_MARKET || "GLOBAL").trim() ||
      "GLOBAL";
    const showLangs = (process.env.DEFAULT_SHOW_LANGS || "en")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const pretranslate = (process.env.DEFAULT_PRETRANSLATE_LANGS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const pivot = process.env.DEFAULT_PIVOT_LANG || "en";
    const def = process.env.DEFAULT_LANG || showLangs[0] || "en";
    return {
      market: fallbackMarket,
      show_langs: showLangs,
      pretranslate_langs: pretranslate,
      default_lang: def,
      pivot_lang: pivot,
    };
  };

  try {
    const market = String(req.query.market || "").trim();

    // Helpers for safe normalization across schema variants
    const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));
    const asArray = (v) => {
      if (Array.isArray(v)) return v;
      if (v == null) return [];
      if (typeof v === "string") {
        const s = v.trim();
        if (!s) return [];
        // Try JSON first
        try {
          const parsed = JSON.parse(s);
          if (Array.isArray(parsed)) return parsed;
        } catch (_) {}
        // Try Postgres array literal {a,b,c}
        const isPgArr = s.startsWith("{") && s.endsWith("}");
        const body = isPgArr ? s.slice(1, -1) : s;
        return body
          .split(",")
          .map((x) => x.replace(/^\"(.*)\"$/, "$1").trim())
          .filter(Boolean);
      }
      return [];
    };
    const normLangs = (v) =>
      uniq(asArray(v).map((x) => normalizeBcp47(String(x || "").trim())));
    const mapMarketRow = (r) => {
      const code = r.market_code || r.code || r.market || r.slug || "GLOBAL";
      const enabled = r.enabled === undefined ? true : !!r.enabled;
      return {
        market: code,
        show_langs: normLangs(r.show_langs),
        pretranslate_langs: normLangs(r.pretranslate_langs),
        default_lang: normalizeBcp47(
          r.default_lang || normLangs(r.show_langs)[0] || "en"
        ),
        pivot_lang: normalizeBcp47(r.pivot_lang || "en"),
        __enabled: enabled,
      };
    };

    // Be schema-tolerant: select all columns, filter client-side
    const { data, error } = await supabase.from("app_markets").select("*");
    if (error) {
      console.warn(
        "/config: falling back due to DB error:",
        error?.message || error
      );
      if (market) return res.json(buildFallback(market));
      return res.json({ markets: [buildFallback("GLOBAL")] });
    }

    let rows = (data || []).map(mapMarketRow).filter((r) => r.__enabled);
    if (market) {
      // Try to find exact match by code
      const r =
        rows.find((x) => String(x.market) === market) ||
        rows.find(
          (x) => String(x.market).toUpperCase() === market.toUpperCase()
        ) ||
        null;
      if (!r) return res.json(buildFallback(market));
      // Strip helper field
      const { __enabled, ...clean } = r;
      return res.json(clean);
    }
    // No market param: return enabled markets summary or fallback
    if (!rows.length) return res.json({ markets: [buildFallback("GLOBAL")] });
    // Strip helper fields
    rows = rows.map(({ __enabled, ...rest }) => rest);
    return res.json({ markets: rows });
  } catch (e) {
    console.error("/config failed", e.message);
    bffMetrics.config.errors += 1;
    // Last-resort fallback to avoid breaking FE
    const market = String(req.query.market || "").trim();
    if (market) return res.json(buildFallback(market));
    return res.json({ markets: [buildFallback("GLOBAL")] });
  }
});

// POST /translate/batch?lang=X
// Body: { ids: [cluster_id...] }
// Simple IP token bucket limiter for batch endpoint (dynamic env read)
function _rateLimitBatchLimit() {
  const v = parseInt(process.env.RATE_LIMIT_BATCH || "60");
  return Number.isFinite(v) && v >= 0 ? v : 60;
}
const _ipBuckets = new Map();
function _takeToken(ip) {
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;
  const rec = _ipBuckets.get(ip) || {
    windowStart: now,
    tokens: _rateLimitBatchLimit(),
  };
  if (now - rec.windowStart >= hourMs) {
    rec.windowStart = now;
    rec.tokens = _rateLimitBatchLimit();
  }
  if (rec.tokens <= 0) {
    _ipBuckets.set(ip, rec);
    return false;
  }
  rec.tokens -= 1;
  _ipBuckets.set(ip, rec);
  return true;
}

app.post("/translate/batch", langMiddleware, async (req, res) => {
  bffMetrics.batch.requests += 1;
  const ip =
    req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";
  if (!_takeToken(ip)) {
    bffMetrics.batch.limited += 1;
    try {
      console.warn("metric: bff.batch.limited", { ip });
    } catch (_) {}
    return res.status(429).json({ error: "rate_limited" });
  }
  const target = req.lang;
  try {
    // Accept either { ids: [...] } or { clusterIds: [...] }
    const bodyIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const bodyClusterIds = Array.isArray(req.body?.clusterIds)
      ? req.body.clusterIds
      : [];
    const ids = (bodyIds.length ? bodyIds : bodyClusterIds).filter(Boolean);
    if (!ids.length) {
      try {
        console.info("metric: bff.batch.requests", { count: 0 });
      } catch (_) {}
      return res.json({ results: [], failed: [] });
    }
    const uniqueIds = [...new Set(ids)].slice(0, 20);
    const perItemMs = parseInt(process.env.BATCH_TRANSLATE_ITEM_MS || "6000");
    const conc = parseInt(process.env.BATCH_TRANSLATE_CONCURRENCY || "6");

    const queue = [...uniqueIds];
    const results = [];
    const failed = [];
    const workers = Array.from(
      { length: Math.max(1, Math.min(conc, 12)) },
      () =>
        (async () => {
          while (queue.length) {
            const id = queue.shift();
            if (!id) break;
            try {
              const ensured = await withTimeout(
                ensureClusterTextInLangDedup(id, target),
                perItemMs,
                `batch ensure ${id}`
              );
              if (!ensured) {
                failed.push(id);
                continue;
              }
              results.push({
                id,
                status: "ready",
                title: ensured.ai_title,
                summary: ensured.ai_summary,
                language: target,
                is_translated: ensured.is_translated || true,
                translated_from: ensured.translated_from || null,
                dir: dirFor(target),
              });
            } catch (_) {
              failed.push(id);
            }
          }
        })()
    );
    await Promise.all(workers);
    if (failed.length) {
      bffMetrics.batch.failed += failed.length;
      try {
        console.warn("metric: bff.batch.failed", { count: failed.length });
      } catch (_) {}
    }
    bffMetrics.batch.succeeded += results.length;
    try {
      console.info("metric: bff.batch.succeeded", { count: results.length });
    } catch (_) {}
    res.json({ results, failed });
  } catch (e) {
    console.error("/translate/batch failed", e.message);
    bffMetrics.batch.failed += 1;
    try {
      console.warn("metric: bff.batch.failed", { count: 1 });
    } catch (_) {}
    res.status(500).json({ error: "Failed to translate batch" });
  }
});
