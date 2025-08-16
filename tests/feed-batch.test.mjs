import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { step } from "./testStep.mjs";

// Provide minimal env required by server early
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "test_key";
process.env.BFF_TRANSLATION_TAG = "off";
process.env.NODE_ENV = "test";

// Datasets to drive the mock Supabase
const datasets = {
  clusters: [
    { id: "clu_a", rep_article: "art_a" },
    { id: "clu_b", rep_article: "art_b" },
  ],
  rep_article: [
    {
      id: "art_a",
      title: "Rep A",
      snippet: "",
      published_at: new Date(Date.now() - 1000).toISOString(),
      language: "en",
      canonical_url: "https://rep/a",
      url: "https://rep/a",
      source_id: null,
    },
    {
      id: "art_b",
      title: "Rep B",
      snippet: "",
      published_at: new Date().toISOString(),
      language: "en",
      canonical_url: "https://rep/b",
      url: "https://rep/b",
      source_id: null,
    },
  ],
  // Current pivot rows (en) for both clusters
  cluster_ai_currents: [
    {
      id: "ai_en_a",
      cluster_id: "clu_a",
      lang: "en",
      ai_title: "Pivot A Title",
      ai_summary: "Pivot A Summary",
      ai_details: "Pivot A Details",
      is_current: true,
      created_at: new Date().toISOString(),
    },
    {
      id: "ai_en_b",
      cluster_id: "clu_b",
      lang: "en",
      ai_title: "Pivot B Title",
      ai_summary: "Pivot B Summary",
      ai_details: "Pivot B Details",
      is_current: true,
      created_at: new Date().toISOString(),
    },
  ],
  // Only one ready target in German (de) to force a pending card for the other one
  cluster_ai_targets: [
    {
      id: "ai_de_b",
      cluster_id: "clu_b",
      lang: "de",
      ai_title: "DE:Pivot B Title",
      ai_summary: "DE:Pivot B Summary",
      ai_details: "DE:Pivot B Details",
      is_current: true,
      created_at: new Date().toISOString(),
      model: "bff-stub#ph=deadbeef",
      pivot_hash: "deadbeef",
    },
  ],
  // Coverage counts query reads from articles table by cluster_id
  coverage_articles: [
    { id: "ca1", cluster_id: "clu_a" },
    { id: "ca2", cluster_id: "clu_a" },
    { id: "cb1", cluster_id: "clu_b" },
  ],
};

// Robust Supabase mock with awaitable query builder
vi.mock("@supabase/supabase-js", () => {
  class Builder {
    constructor(table) {
      this.table = table;
      this._filters = {};
      this._in = null;
      this._limit = null;
      this._order = null;
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
    order(k, { ascending } = { ascending: true }) {
      this._order = { k, ascending };
      return this;
    }
    limit(n) {
      this._limit = n;
      return this;
    }
    insert() {
      return this;
    }
    update() {
      return this;
    }
    _resolve() {
      if (this.table === "clusters") {
        // Return a shallow copy to avoid accidental test mutation
        const list = datasets.clusters.slice(0, this._limit || undefined);
        return { data: list, error: null };
      }
      if (this.table === "articles") {
        // Two different shapes used by server: rep article by id, and coverage by cluster_id
        if (this._filters.cluster_id && this._in) {
          const ids = this._in.arr || [];
          const list = datasets.coverage_articles.filter((a) =>
            ids.includes(a.cluster_id)
          );
          return { data: list, error: null };
        }
        if (this._in && this._in.k === "id") {
          const ids = this._in.arr || [];
          const list = datasets.rep_article.filter((a) => ids.includes(a.id));
          return { data: list, error: null };
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
          // target lookup
          const row = datasets.cluster_ai_targets.find(
            (r) => r.cluster_id === cid && r.lang === lang && r.is_current
          );
          return { data: row || null, error: null };
        }
        // currents for a cluster
        const list = datasets.cluster_ai_currents.filter(
          (r) => r.cluster_id === cid && r.is_current
        );
        return { data: list, error: null };
      }
      if (this.table === "sources") {
        return { data: [], error: null };
      }
      if (this.table === "categories" || this.table === "article_categories") {
        return { data: [], error: null };
      }
      if (this.table === "cluster_updates") {
        return { data: [], error: null };
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
  return {
    createClient: () => ({ from: (t) => new Builder(t) }),
  };
});

// Mock translator used by server to avoid network calls
vi.mock("../src/utils/textTranslate.mjs", () => ({
  translateTextCached: vi.fn(async (text, { dstLang }) => {
    const base = (s) => (s || "").split("-")[0];
    if (base(dstLang) === "de") return `DE:${text}`;
    return text;
  }),
  translateFieldsCached: vi.fn(
    async ({ title, summary, details }, { dstLang }) => {
      const base = (s) => (s || "").split("-")[0];
      if (base(dstLang) === "de") {
        return {
          title: `DE:${title}`,
          summary: `DE:${summary}`,
          details: `DE:${details}`,
        };
      }
      return { title, summary, details };
    }
  ),
}));

// Now import the app
import { app } from "../server.mjs";

describe("/feed and /translate/batch", () => {
  beforeEach(() => {
    // Reset any incidental state if needed
  });

  it("non-strict /feed marks missing targets as pending and sets header", async () => {
    const res = await step(
      "When I request /feed?lang=de (non-strict)",
      async () => request(app).get("/feed?lang=de")
    );
    await step(
      "Then response is 200 and pending header includes clu_a",
      async () => {
        expect(res.status).toBe(200);
        const header = res.headers["x-pending-cluster-ids"] || "";
        expect(header.split(",").filter(Boolean)).toContain("clu_a");
      }
    );
    await step("And cards have mixed statuses (pending/ready)", async () => {
      const cards = res.body;
      expect(Array.isArray(cards)).toBe(true);
      const byId = new Map(cards.map((c) => [c.id, c]));
      expect(byId.get("clu_a").translation_status).toBe("pending");
      expect(byId.get("clu_b").translation_status).toBe("ready");
    });
  });

  it("/translate/batch dedupes ids and returns ready results", async () => {
    const res = await step(
      "When I POST to /translate/batch with duplicate ids",
      async () =>
        request(app)
          .post("/translate/batch?lang=de")
          .send({ ids: ["clu_a", "clu_b", "clu_a"] })
    );
    await step(
      "Then unique results are returned with no failures",
      async () => {
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.results)).toBe(true);
        const ids = res.body.results.map((r) => r.id).sort();
        expect(ids).toEqual(["clu_a", "clu_b"]);
        expect(res.body.failed || []).toEqual([]);
      }
    );
  });
});
