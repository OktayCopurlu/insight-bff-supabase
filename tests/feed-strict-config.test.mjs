import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { step } from "./testStep.mjs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "test_key";
process.env.BFF_TRANSLATION_TAG = "off";
process.env.NODE_ENV = "test";

const datasets = {
  clusters: [
    { id: "clu_s1", rep_article: "a1" },
    { id: "clu_s2", rep_article: "a2" },
  ],
  rep_article: [
    {
      id: "a1",
      title: "Rep 1",
      snippet: "",
      published_at: new Date(Date.now() - 1000).toISOString(),
      language: "en",
      canonical_url: "https://rep/1",
      url: "https://rep/1",
      source_id: null,
    },
    {
      id: "a2",
      title: "Rep 2",
      snippet: "",
      published_at: new Date().toISOString(),
      language: "en",
      canonical_url: "https://rep/2",
      url: "https://rep/2",
      source_id: null,
    },
  ],
  // Only pivots exist initially (en)
  cluster_ai_currents: [
    {
      id: "ai_en_s1",
      cluster_id: "clu_s1",
      lang: "en",
      ai_title: "Pivot S1",
      ai_summary: "Pivot S1 summary",
      ai_details: "Pivot S1 details",
      is_current: true,
      created_at: new Date().toISOString(),
    },
    {
      id: "ai_en_s2",
      cluster_id: "clu_s2",
      lang: "en",
      ai_title: "Pivot S2",
      ai_summary: "Pivot S2 summary",
      ai_details: "Pivot S2 details",
      is_current: true,
      created_at: new Date().toISOString(),
    },
  ],
  cluster_ai_targets: [],
  coverage_articles: [
    { id: "x1", cluster_id: "clu_s1" },
    { id: "x2", cluster_id: "clu_s2" },
  ],
  app_markets: [
    {
      id: "m1",
      market_code: "CH",
      enabled: true,
      show_langs: ["de", "fr", "it"],
      pretranslate_langs: ["de", "fr"],
      default_lang: "de",
      pivot_lang: "en",
    },
  ],
};

vi.mock("@supabase/supabase-js", () => {
  class Builder {
    constructor(table) {
      this.table = table;
      this._filters = {};
      this._in = null;
      this._limit = null;
    }
    select() {
      return this;
    }
    eq(k, v) {
      this._filters[k] = v;
      return this;
    }
    in(k, arr) {
      this._in = { k, arr };
      return this;
    }
    order() {
      return this;
    }
    limit(n) {
      this._limit = n;
      return this;
    }
    insert(v) {
      // Simulate persisting new target rows by pushing to targets
      if (this.table === "cluster_ai") {
        const arr = Array.isArray(v) ? v : [v];
        for (const r of arr) {
          datasets.cluster_ai_targets.push({
            ...r,
            id: r.id || `t_${Math.random().toString(36).slice(2, 8)}`,
          });
        }
      }
      return this;
    }
    update() {
      return this;
    }
    _resolve() {
      if (this.table === "clusters") {
        return {
          data: datasets.clusters.slice(0, this._limit || undefined),
          error: null,
        };
      }
      if (this.table === "articles") {
        if (this._in && this._in.k === "id") {
          const ids = this._in.arr || [];
          return {
            data: datasets.rep_article.filter((a) => ids.includes(a.id)),
            error: null,
          };
        }
        if (this._filters.cluster_id && this._in) {
          const ids = this._in.arr || [];
          return {
            data: datasets.coverage_articles.filter((a) =>
              ids.includes(a.cluster_id)
            ),
            error: null,
          };
        }
        return { data: datasets.rep_article, error: null };
      }
      if (this.table === "article_media" || this.table === "media_assets") {
        return { data: [], error: null };
      }
      if (this.table === "cluster_ai") {
        const cid = this._filters.cluster_id;
        const lang = this._filters.lang;
        if (lang) {
          const row =
            datasets.cluster_ai_targets.find(
              (r) =>
                r.cluster_id === cid &&
                r.lang === lang &&
                r.is_current !== false
            ) || null;
          return { data: row, error: null };
        }
        const list = datasets.cluster_ai_currents.filter(
          (r) => r.cluster_id === cid && r.is_current
        );
        return { data: list, error: null };
      }
      if (
        this.table === "sources" ||
        this.table === "categories" ||
        this.table === "article_categories" ||
        this.table === "cluster_updates"
      ) {
        return { data: [], error: null };
      }
      if (this.table === "app_markets") {
        const enabledOnly = datasets.app_markets.filter(
          (m) =>
            this._filters.enabled === undefined ||
            m.enabled === this._filters.enabled
        );
        const filtered = this._filters.market_code
          ? enabledOnly.filter(
              (m) => m.market_code === this._filters.market_code
            )
          : enabledOnly;
        return { data: filtered, error: null };
      }
      return { data: [], error: null };
    }
    maybeSingle() {
      return Promise.resolve(this._resolve());
    }
    single() {
      return Promise.resolve(this._resolve());
    }
    then(onFulfilled, onRejected) {
      return Promise.resolve(this._resolve()).then(onFulfilled, onRejected);
    }
    catch(onRejected) {
      return Promise.resolve(this._resolve()).catch(onRejected);
    }
    finally(onFinally) {
      return Promise.resolve(this._resolve()).finally(onFinally);
    }
  }
  return { createClient: () => ({ from: (t) => new Builder(t) }) };
});

vi.mock("../src/utils/textTranslate.mjs", () => ({
  translateTextCached: vi.fn(
    async (text, { dstLang }) => `(${dstLang}) ${text}`
  ),
  translateFieldsCached: vi.fn(
    async ({ title, summary, details }, { dstLang }) => ({
      title: `(${dstLang}) ${title}`,
      summary: `(${dstLang}) ${summary}`,
      details: `(${dstLang}) ${details}`,
    })
  ),
}));

import { app } from "../server.mjs";

describe("/feed strict mode and /config", () => {
  it("/feed?strict=1 returns ready cards translated to target", async () => {
    const res = await step("When I request /feed in strict mode in fr", async () =>
      request(app).get("/feed?lang=fr&strict=1&limit=5")
    );
    await step("Then it returns ready cards in fr language", async () => {
      expect(res.status).toBe(200);
      const cards = res.body;
      expect(Array.isArray(cards)).toBe(true);
      expect(cards.length).toBeGreaterThanOrEqual(1);
      for (const c of cards) {
        expect(typeof c.title).toBe("string");
        expect(c.translation_status).toBe("ready");
        expect(c.language).toBe("fr");
      }
    });
  });

  it("/config?market=CH returns a single market with expected fields", async () => {
    const res = await step("When I request /config?market=CH", async () =>
      request(app).get("/config?market=CH")
    );
    await step("Then market config contains required fields", async () => {
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("market", "CH");
      expect(res.body).toHaveProperty("show_langs");
      expect(res.body).toHaveProperty("pretranslate_langs");
      expect(res.body).toHaveProperty("default_lang");
      expect(res.body).toHaveProperty("pivot_lang", "en");
    });
  });
});
