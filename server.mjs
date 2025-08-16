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
import { translateTextCached, translateFieldsCached } from "./src/utils/textTranslate.mjs";

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

// Demo fallback articles for legacy /articles endpoint
const FALLBACK_ARTICLES = [
  {
    id: "demo-1",
    title: "Demo Article 1",
    snippet: "Sample summary one.",
    published_at: new Date(Date.now() - 1800_000).toISOString(),
    language: "en",
    canonical_url: "https://example.com/1",
    url: "https://example.com/1",
    source_id: null,
  },
  {
    id: "demo-2",
    title: "Demo Article 2",
    snippet: "Sample summary two.",
    published_at: new Date(Date.now() - 3600_000).toISOString(),
    language: "en",
    canonical_url: "https://example.com/2",
    url: "https://example.com/2",
    source_id: null,
  },
];

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

// fall back to demo articles. This keeps a single FE endpoint: /articles.
app.get("/articles", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    // 1. Fetch current AI rows (driver set)
    let aiCurrent = [];
    try {
      const { data, error } = await withTimeout(
        supabase
          .from("article_ai")
          .select(
            "article_id,ai_title,ai_summary,ai_details,is_current,created_at"
          )
          .eq("is_current", true)
          .order("created_at", { ascending: false })
          .limit(limit + 10), // small over-fetch for later filtering
        2500,
        "article_ai current"
      );
      if (error) throw error;
      aiCurrent = data || [];
      console.log(
        `[BFF:/articles] AI driver rows fetched: ${aiCurrent.length}`
      );
    } catch (e) {
      console.warn("AI driver query failed, fallback to demo:", e.message);
      // respond with fallback immediately (no DB article join possible)
      return res.json(
        FALLBACK_ARTICLES.map((a) => ({
          id: a.id,
          title: a.title,
          summary: a.snippet,
          // no AI explanation available
          ai_explanation: null,
          explanation_generated: false,
          category: "general",
          language: a.language,
          source: "Unknown",
          source_url: a.canonical_url || a.url,
          image_url: null,
          published_at: a.published_at,
          reading_time: 1,
          tags: [],
        }))
      );
    }

    if (!aiCurrent.length) {
      // Nothing AI-processed yet -> fallback
      console.warn(
        "[BFF:/articles] No aiCurrent rows found; returning fallback demo articles"
      );
      return res.json(
        FALLBACK_ARTICLES.map((a) => ({
          id: a.id,
          title: a.title,
          summary: a.snippet,
          ai_explanation: null,
          explanation_generated: false,
          category: "general",
          language: a.language,
          source: "Unknown",
          source_url: a.canonical_url || a.url,
          image_url: null,
          published_at: a.published_at,
          reading_time: 1,
          tags: [],
        }))
      );
    }

    const articleIds = [...new Set(aiCurrent.map((r) => r.article_id))].slice(
      0,
      limit
    );

    // 2. Fetch articles
    const { data: articlesData, error: articlesErr } = await withTimeout(
      supabase
        .from("articles")
        .select(
          "id,title,snippet,published_at,language,canonical_url,url,source_id"
        )
        .in("id", articleIds.length ? articleIds : ["__none__"]),
      2500,
      "articles join"
    );
    if (articlesErr) throw articlesErr;
    const articleMap = new Map();
    (articlesData || []).forEach((a) => articleMap.set(a.id, a));
    console.log(`[BFF:/articles] Base articles joined: ${articleMap.size}`);

    // 3. Sources
    const sourceIds = [
      ...new Set((articlesData || []).map((a) => a.source_id).filter(Boolean)),
    ];
    let sources = [];
    try {
      if (sourceIds.length) {
        const { data } = await withTimeout(
          supabase
            .from("sources")
            .select("id,name,homepage")
            .in("id", sourceIds.length ? sourceIds : ["__none__"]),
          1500,
          "sources"
        );
        sources = data || [];
      }
    } catch (e) {
      console.warn("sources fetch warn", e.message);
    }
    const sourceMap = new Map();
    sources.forEach((s) => sourceMap.set(s.id, s));

    // 4. Category links
    let catLinks = [];
    try {
      const { data } = await withTimeout(
        supabase
          .from("article_categories")
          .select("article_id,category_id")
          .in("article_id", articleIds.length ? articleIds : ["__none__"]),
        1500,
        "article_categories"
      );
      catLinks = data || [];
    } catch (e) {
      console.warn("categories link warn", e.message);
    }
    const catIds = [...new Set(catLinks.map((c) => c.category_id))];
    let categoriesAll = [];
    try {
      if (catIds.length) {
        const { data } = await withTimeout(
          supabase
            .from("categories")
            .select("id,path")
            .in("id", catIds.length ? catIds : ["__none__"]),
          1500,
          "categories"
        );
        categoriesAll = data || [];
      }
    } catch (e) {
      console.warn("categories fetch warn", e.message);
    }
    const catPath = new Map();
    categoriesAll.forEach((c) => catPath.set(c.id, c.path));
    const articleCats = new Map();
    catLinks.forEach((cl) => {
      const list = articleCats.get(cl.article_id) || [];
      const p = catPath.get(cl.category_id);
      if (p) list.push(p);
      articleCats.set(cl.article_id, list);
    });

    // 5. Media (thumbnail only)
    let mediaLinks = [];
    try {
      const { data } = await withTimeout(
        supabase
          .from("article_media")
          .select("article_id,media_id,role")
          .in("article_id", articleIds.length ? articleIds : ["__none__"])
          .eq("role", "thumbnail"),
        1500,
        "article_media"
      );
      mediaLinks = data || [];
    } catch (e) {
      console.warn("media links warn", e.message);
    }
    const mediaIds = mediaLinks.map((m) => m.media_id);
    let mediaAssets = [];
    try {
      if (mediaIds.length) {
        const { data } = await withTimeout(
          supabase
            .from("media_assets")
            .select("id,url")
            .in("id", mediaIds.length ? mediaIds : ["__none__"]),
          1500,
          "media_assets"
        );
        mediaAssets = data || [];
      }
    } catch (e) {
      console.warn("media assets warn", e.message);
    }
    const mediaMap = new Map();
    mediaAssets.forEach((m) => mediaMap.set(m.id, m.url));
    const thumbMap = new Map();
    mediaLinks.forEach((m) => {
      if (!thumbMap.has(m.article_id))
        thumbMap.set(m.article_id, mediaMap.get(m.media_id) || null);
    });

    // 6. Assemble
    const enriched = aiCurrent
      .filter((r) => articleMap.has(r.article_id))
      .slice(0, limit)
      .map((ai) => {
        const a = articleMap.get(ai.article_id);
        const cats = articleCats.get(a.id) || [];
        const summary = ai.ai_summary || a.snippet || "";
        const readingTime = Math.max(
          1,
          Math.ceil(summary.split(/\s+/).length / 200)
        );
        return {
          id: a.id,
          title: ai.ai_title || a.title,
          summary,
          ai_explanation: ai.ai_details || null,
          explanation_generated: !!ai.ai_details,
          category: cats[0] || "general",
          language: a.language,
          source: sourceMap.get(a.source_id || "")?.name || "Unknown",
          source_url: a.canonical_url || a.url,
          image_url: thumbMap.get(a.id) || null,
          published_at: a.published_at,
          reading_time: readingTime,
          tags: cats,
        };
      })
      // sort by published_at desc for stable ordering
      .sort((a, b) => (a.published_at > b.published_at ? -1 : 1));

    console.log(
      `[BFF:/articles] Responding with enriched articles: ${enriched.length}`
    );
    res.json(enriched);
  } catch (err) {
    console.error("Unified /articles failed", err.message);
    res.status(500).json({ error: "Failed to load articles" });
  }
});

// LIST AI ENHANCEMENTS (must be before /articles/:id so 'ai' isn't treated as an id)
// GET /articles/ai/enhancements?article_id=...&is_current=true|false|any&since_hours=24&limit=50&offset=0&order=desc
// Deprecated: /articles/ai/enhancements (now unified under /articles). Return 410 for clarity.
app.get("/articles/ai/enhancements", (_req, res) => {
  res
    .status(410)
    .json({ error: "Deprecated. Use /articles for AI-powered articles." });
});

// GET full AI history for a single article
// GET /articles/:id/ai/history
app.get("/articles/:id/ai/history", async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from("article_ai")
      .select(
        "id,article_id,ai_title,ai_summary,ai_details,ai_language,is_current,model,prompt_hash,created_at"
      )
      .eq("article_id", id)
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ success: true, count: data?.length || 0, data: data || [] });
  } catch (err) {
    console.error("AI history fetch failed", err.message);
    res
      .status(500)
      .json({ success: false, error: "Failed to fetch AI history" });
  }
});

// GET /articles/:id
app.get("/articles/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const { data: base, error: baseErr } = await supabase
      .from("articles")
      .select(
        "id,title,snippet,published_at,language,canonical_url,url,source_id"
      )
      .eq("id", id)
      .single();
    if (baseErr) return res.status(404).json({ error: "Not found" });
    const { data: ai } = await supabase
      .from("article_ai")
      .select("ai_title,ai_summary,ai_details")
      .eq("article_id", id)
      .eq("is_current", true)
      .maybeSingle();
    const { data: catLinks } = await supabase
      .from("article_categories")
      .select("category_id")
      .eq("article_id", id);
    const catIds = (catLinks || []).map((c) => c.category_id);
    const { data: cats } = await supabase
      .from("categories")
      .select("id,path")
      .in("id", catIds.length ? catIds : ["__none__"]);
    const categories = cats?.map((c) => c.path) || [];
    const { data: mediaLink } = await supabase
      .from("article_media")
      .select("media_id")
      .eq("article_id", id)
      .eq("role", "thumbnail")
      .limit(1);
    let image_url = null;
    if (mediaLink && mediaLink[0]) {
      const { data: asset } = await supabase
        .from("media_assets")
        .select("url")
        .eq("id", mediaLink[0].media_id)
        .single();
      image_url = asset?.url || null;
    }
    const summary = ai?.ai_summary || base.snippet || "";
    const readingTime = Math.max(
      1,
      Math.ceil(summary.split(/\s+/).length / 200)
    );
    res.json({
      id: base.id,
      title: ai?.ai_title || base.title,
      summary,
      ai_explanation: ai?.ai_details || null,
      explanation_generated: !!ai?.ai_details,
      category: categories[0] || "general",
      language: base.language,
      source: base.source_id || "unknown",
      source_url: base.canonical_url || base.url,
      image_url,
      published_at: base.published_at,
      reading_time: readingTime,
      tags: categories,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /articles/:id/explanation  (stub AI explanation generation)
app.post("/articles/:id/explanation", async (req, res) => {
  const { id } = req.params;
  try {
    // naive: derive explanation from existing ai_summary or snippet
    const { data: base } = await supabase
      .from("articles")
      .select("id,snippet,title")
      .eq("id", id)
      .maybeSingle();
    if (!base) return res.status(404).json({ error: "Not found" });
    const explanation = `Detailed context for: ${base.title}\n\n${
      base.snippet || "No snippet."
    }\n\n(This is a placeholder AI explanation generated by the BFF.)`;
    // Optionally persist into article_ai table if desired (skip for now)
    return res.json({ explanation });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /articles/:id/eli5  (simple summary)
app.post("/articles/:id/eli5", async (req, res) => {
  const { id } = req.params;
  try {
    const { data: base } = await supabase
      .from("articles")
      .select("id,title,snippet")
      .eq("id", id)
      .maybeSingle();
    if (!base) return res.status(404).json({ error: "Not found" });
    const eli5_summary = `This article is about: ${
      base.title
    }. In simple words: ${(base.snippet || "It explains something.").slice(
      0,
      140
    )}...`;
    res.json({ eli5_summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// QUIZ endpoints
app.post("/articles/:id/quiz", async (req, res) => {
  const { id } = req.params;
  const { difficulty = "intermediate" } = req.body || {};
  try {
    if (quizzes.has(id)) return res.json(quizzes.get(id));
    const quiz = {
      id: genId("quiz_"),
      article_id: id,
      difficulty,
      questions: [
        {
          id: genId("q_"),
          question: "Placeholder question about article " + id,
          options: ["A", "B", "C", "D"],
          correctAnswer: 0,
          explanation: "Demo quiz.",
        },
      ],
    };
    quizzes.set(id, quiz);
    res.json(quiz);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});
app.get("/articles/:id/quiz", (req, res) => {
  const q = quizzes.get(req.params.id);
  if (!q) return res.status(404).json({ error: "Quiz not found" });
  res.json(q);
});

// COVERAGE endpoints
app.post("/articles/:id/coverage", async (req, res) => {
  const { id } = req.params;
  try {
    if (coverageStore.has(id)) return res.json(coverageStore.get(id));
    const coverage = {
      comparisons: [
        {
          source: "Source A",
          perspective: "Focuses on economic angle",
          bias: 0.1,
        },
        {
          source: "Source B",
          perspective: "Highlights social impact",
          bias: -0.05,
        },
      ],
    };
    coverageStore.set(id, coverage);
    res.json(coverage);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});
app.get("/articles/:id/coverage", (req, res) => {
  const c = coverageStore.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Coverage not found" });
  res.json(c);
});

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
  const apiKey = process.env.LLM_API_KEY || process.env.GEMINI_API_KEY || "";
  const modelId =
    process.env.LLM_MODEL || process.env.GEMINI_MODEL || "gemini-1.5-flash";
  if (apiKey) {
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
        `Base your answer on the provided cluster summary, timeline, and citations.`,
        `If uncertain, say you don't have enough info. Do not invent facts.`,
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

      const { GoogleGenerativeAI } = await import("@google/generative-ai");
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: modelId });
      const prompt = [
        instructions,
        `Question: ${message}`,
        context ? `\n\nContext:\n${context}` : "",
      ].join("\n\n");
      const resp = await withTimeout(
        model.generateContent(prompt),
        8000,
        "gemini chat"
      );
      const txt = resp?.response?.text?.() || "";
      reply = (txt || "").trim();
      if (!reply) throw new Error("empty gemini reply");
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
  // Include top citations for grounding
  let citations = [];
  try {
    citations = await getClusterCitations(id, 3);
  } catch (_) {}
  res.json({ messages: history, citations });
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
  if (existingTarget) {
    try {
      const tCreated = Date.parse(existingTarget.created_at || 0) || 0;
      const pCreated = Date.parse(pivot.created_at || 0) || 0;
      // Also detect legacy rows where the title wasn't translated (title equals pivot title but languages differ)
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const needsRefreshTitle =
        norm(existingTarget.ai_title) === norm(pivot.ai_title) &&
        (existingTarget.lang || "") !== (pivot.lang || "");
      const needsRefreshSummary =
        norm(existingTarget.ai_summary) === norm(pivot.ai_summary) &&
        (existingTarget.lang || "") !== (pivot.lang || "");
      const needsRefreshDetails =
        norm(existingTarget.ai_details) === norm(pivot.ai_details) &&
        (existingTarget.lang || "") !== (pivot.lang || "");
      // Detect stub marker from earlier fallback translations
      const stubMarker = " [translated]";
      const hasStubMarker =
        (existingTarget.ai_title || "").includes(stubMarker) ||
        (existingTarget.ai_summary || "").includes(stubMarker) ||
        (existingTarget.ai_details || "").includes(stubMarker);
      // If existing model encodes the same pivot signature, prefer it as fresh
      const modelTag = (existingTarget.model || "").toString();
      const samePivotSig =
        (existingTarget.pivot_hash && existingTarget.pivot_hash === pivotSig) ||
        modelTag.includes(`#ph=${pivotSig}`);
      if (
        (samePivotSig || tCreated >= pCreated) &&
        !needsRefreshTitle &&
        !needsRefreshSummary &&
        !needsRefreshDetails &&
        !hasStubMarker
      ) {
        // Fresh enough
        return {
          ...existingTarget,
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
        .eq("id", existingTarget.id);
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
      return { ...existingTarget, is_translated: false, translated_from: null };
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
  if (base(s) === base(d)) return { ...pivot };
  // Prefer single-call translation to reduce provider calls; fallback to per-field helper internally
  const { title, summary, details } = await translateFieldsCached(
    {
      title: pivot.ai_title || "",
      summary: pivot.ai_summary || "",
      details: pivot.ai_details || pivot.ai_summary || "",
    },
    { srcLang: s, dstLang: d }
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
app.get("/feed", langMiddleware, async (req, res) => {
  const target = req.lang;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const strict = String(req.query.strict || "").toLowerCase();
  const waitTranslations =
    strict === "1" || strict === "true" || strict === "yes";
  // Adaptive DB timeouts: allow more time in strict mode
  const DB_T_MS = waitTranslations ? 8000 : 2000;
  const DB_T_FAST_MS = waitTranslations ? 4000 : 1500;
  // In strict mode, cap the number of items to keep response time reasonable
  const effectiveLimit = waitTranslations ? Math.min(limit, 8) : limit;
  // Overall time budget for strict mode (keep under FE wait window)
  const STRICT_BUDGET_MS = parseInt(
    process.env.FEED_STRICT_BUDGET_MS || "18000"
  );
  const overallDeadline = waitTranslations ? Date.now() + STRICT_BUDGET_MS : 0;
  try {
    const t0 = Date.now();
    // Recent clusters: order by rep_article.published_at desc when possible
    const { data: clusters, error: clErr } = await withTimeout(
      supabase
        .from("clusters")
        .select("id,rep_article")
        .limit(effectiveLimit * 3),
      DB_T_MS,
      "clusters list"
    );
    if (clErr) throw clErr;
    if (!clusters || !clusters.length) return res.json([]);

    // Get rep articles to sort and fetch thumbnails
    const repIds = clusters.map((c) => c.rep_article).filter(Boolean);
    const { data: repArticles } = await withTimeout(
      supabase
        .from("articles")
        .select("id,title,snippet,published_at,language")
        .in("id", repIds.length ? repIds : ["__none__"]),
      DB_T_MS,
      "rep articles"
    );
    const repMap = new Map((repArticles || []).map((a) => [a.id, a]));
    const ordered = [...clusters].sort((a, b) => {
      const pa = repMap.get(a.rep_article)?.published_at || "";
      const pb = repMap.get(b.rep_article)?.published_at || "";
      return pa > pb ? -1 : 1;
    });

    const picked = ordered.slice(0, effectiveLimit);
    const clusterIds = picked.map((c) => c.id);

    // Preload thumb urls for reps
    const { data: mediaLinks } = await withTimeout(
      supabase
        .from("article_media")
        .select("article_id,media_id,role")
        .in("article_id", repIds.length ? repIds : ["__none__"])
        .eq("role", "thumbnail"),
      DB_T_FAST_MS,
      "thumb links"
    );
    const mediaIds = (mediaLinks || []).map((m) => m.media_id);
    const { data: assets } = await withTimeout(
      supabase
        .from("media_assets")
        .select("id,url")
        .in("id", mediaIds.length ? mediaIds : ["__none__"]),
      DB_T_FAST_MS,
      "thumb assets"
    );
    const mediaMap = new Map((assets || []).map((m) => [m.id, m.url]));
    const thumbByArticle = new Map();
    (mediaLinks || []).forEach((m) => {
      if (!thumbByArticle.has(m.article_id))
        thumbByArticle.set(m.article_id, mediaMap.get(m.media_id) || null);
    });

    // Derive categories for representative articles (used for FE filters)
    let repCatLinks = [];
    try {
      const { data } = await withTimeout(
        supabase
          .from("article_categories")
          .select("article_id,category_id")
          .in("article_id", repIds.length ? repIds : ["__none__"]),
        DB_T_FAST_MS,
        "rep categories"
      );
      repCatLinks = data || [];
    } catch (e) {
      console.warn("rep categories warn", e.message);
    }
    const repCatIds = [
      ...new Set((repCatLinks || []).map((c) => c.category_id).filter(Boolean)),
    ];
    let repCategories = [];
    try {
      if (repCatIds.length) {
        const { data } = await withTimeout(
          supabase
            .from("categories")
            .select("id,path")
            .in("id", repCatIds.length ? repCatIds : ["__none__"]),
          DB_T_FAST_MS,
          "categories"
        );
        repCategories = data || [];
      }
    } catch (e) {
      console.warn("categories fetch warn", e.message);
    }
    const repCatPath = new Map(repCategories.map((c) => [c.id, c.path]));
    const catsByArticle = new Map();
    (repCatLinks || []).forEach((cl) => {
      const list = catsByArticle.get(cl.article_id) || [];
      const p = repCatPath.get(cl.category_id);
      if (p) list.push(p);
      catsByArticle.set(cl.article_id, list);
    });

    // Coverage counts per cluster (batched)
    const coverageCounts = new Map();
    try {
      const { data: artsAll } = await withTimeout(
        supabase
          .from("articles")
          .select("cluster_id")
          .in("cluster_id", clusterIds.length ? clusterIds : ["__none__"]),
        DB_T_FAST_MS,
        "coverage counts"
      );
      (artsAll || []).forEach((a) =>
        coverageCounts.set(
          a.cluster_id,
          (coverageCounts.get(a.cluster_id) || 0) + 1
        )
      );
    } catch (_) {}

    // Assemble cards with language selection/translation
    const cards = [];
    if (waitTranslations) {
      // In strict mode, try to resolve multiple translations in parallel within the remaining budget
      const buildCardsFromEnsured = (ensuredMap) => {
        for (const c of picked) {
          const ensured = ensuredMap.get(c.id);
          if (!ensured) continue;
          const repThumb = thumbByArticle.get(c.rep_article) || null;
          const repCats = catsByArticle.get(c.rep_article) || [];
          cards.push({
            id: c.id,
            title: ensured.ai_title,
            summary: ensured.ai_summary,
            language: target,
            is_translated: ensured.is_translated || false,
            translated_from: ensured.translated_from || null,
            dir: dirFor(target),
            coverage_count: coverageCounts.get(c.id) || 1,
            image_url: repThumb,
            category: repCats[0] || "general",
            tags: repCats,
            translation_status: "ready",
          });
        }
      };

      const attemptBatch = async (capMs) => {
        const ensuredMap = new Map();
        const promises = picked.map((c) =>
          withTimeout(
            ensureClusterTextInLangDedup(c.id, target),
            capMs,
            `ensure cluster ${c.id}`
          )
            .then((ensured) => ({ ok: true, id: c.id, ensured }))
            .catch(() => ({ ok: false, id: c.id }))
        );
        const settled = await Promise.allSettled(promises);
        for (const s of settled) {
          if (s.status === "fulfilled" && s.value.ok && s.value.ensured) {
            ensuredMap.set(s.value.id, s.value.ensured);
          }
        }
        buildCardsFromEnsured(ensuredMap);
      };

      // First pass with a conservative per-item cap within remaining budget
      let remaining = Math.max(0, overallDeadline - Date.now());
      if (remaining > 0) {
        const cap1 = Math.max(1500, Math.min(3000, remaining));
        await attemptBatch(cap1);
      }
      // If still empty and time remains, try a second pass with a slightly higher cap
      remaining = Math.max(0, overallDeadline - Date.now());
      if (cards.length === 0 && remaining > 0) {
        const cap2 = Math.max(2000, Math.min(5000, remaining));
        await attemptBatch(cap2);
      }
    } else {
      // Non-strict: fast path — return ready targets; mark others as pending (no pivot leakage)
      const pendingIds = [];
      for (const c of picked) {
        let ensured = null;
        try {
          const { data } = await withTimeout(
            supabase
              .from("cluster_ai")
              .select(
                "id,lang,ai_title,ai_summary,ai_details,is_current,created_at"
              )
              .eq("cluster_id", c.id)
              .eq("lang", target)
              .eq("is_current", true)
              .maybeSingle(),
            DB_T_FAST_MS,
            "cluster_ai target (feed)"
          );
          ensured = data || null;
        } catch (_) {}
        const repThumb = thumbByArticle.get(c.rep_article) || null;
        const repCats = catsByArticle.get(c.rep_article) || [];
        if (ensured) {
          cards.push({
            id: c.id,
            title: ensured.ai_title || repMap.get(c.rep_article)?.title || null,
            summary:
              ensured.ai_summary || repMap.get(c.rep_article)?.snippet || null,
            language: target,
            is_translated: true,
            translated_from: null,
            dir: dirFor(target),
            coverage_count: coverageCounts.get(c.id) || 1,
            image_url: repThumb,
            category: repCats[0] || "general",
            tags: repCats,
            translation_status: "ready",
          });
        } else {
          pendingIds.push(c.id);
          // Schedule background persistence
          _enqueuePersist(() => ensureClusterTextInLang(c.id, target));
          cards.push({
            id: c.id,
            title: null,
            summary: null,
            language: target,
            is_translated: false,
            translated_from: null,
            dir: dirFor(target),
            coverage_count: coverageCounts.get(c.id) || 1,
            image_url: repThumb,
            category: repCats[0] || "general",
            tags: repCats,
            translation_status: "pending",
          });
        }
      }
      if (pendingIds.length) {
        try {
          res.setHeader("X-Pending-Cluster-Ids", pendingIds.join(","));
        } catch (_) {}
      }
    }
    res.json(cards);
  } catch (err) {
    console.error("/feed failed", err.message);
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
    const strip = (s) => (s || "").replace(/\s+/g, " ").trim();
    const sameAsSummary =
      strip(ensured.ai_details) && strip(ensured.ai_summary)
        ? strip(ensured.ai_details) === strip(ensured.ai_summary)
        : false;
    let composedDetails = ensured.ai_details || "";
    if (!composedDetails || composedDetails.length < 240 || sameAsSummary) {
      const parts = [];
      if (ensured.ai_summary) parts.push(ensured.ai_summary.trim());
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
      composedDetails = parts.filter(Boolean).join("\n\n");
    }

    res.json({
      id: cluster.id,
      title: ensured.ai_title,
      summary: ensured.ai_summary,
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
    res.status(500).json({ error: "Failed to load cluster" });
  }
});

// (health route already defined above)

// -------------------- Market config + batch translation endpoints --------------------

// GET /config?market=CH
app.get("/config", async (req, res) => {
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
    // Last-resort fallback to avoid breaking FE
    const market = String(req.query.market || "").trim();
    if (market) return res.json(buildFallback(market));
    return res.json({ markets: [buildFallback("GLOBAL")] });
  }
});

// POST /translate/batch?lang=X
// Body: { ids: [cluster_id...] }
app.post("/translate/batch", langMiddleware, async (req, res) => {
  const target = req.lang;
  try {
    // Accept either { ids: [...] } or { clusterIds: [...] }
    const bodyIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const bodyClusterIds = Array.isArray(req.body?.clusterIds)
      ? req.body.clusterIds
      : [];
    const ids = (bodyIds.length ? bodyIds : bodyClusterIds).filter(Boolean);
    if (!ids.length) return res.json({ results: [], failed: [] });
    const uniqueIds = [...new Set(ids)].slice(0, 20);
    const perItemMs = parseInt(process.env.BATCH_TRANSLATE_ITEM_MS || "2000");
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
    res.json({ results, failed });
  } catch (e) {
    console.error("/translate/batch failed", e.message);
    res.status(500).json({ error: "Failed to translate batch" });
  }
});
