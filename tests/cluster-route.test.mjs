import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import path from "path";
import { step } from "./testStep.mjs";

// Provide minimal env required by server early
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "test_key";
process.env.BFF_TRANSLATION_TAG = "off";
process.env.NODE_ENV = "test";

// Robust Supabase mock with awaitable query builder
vi.mock("@supabase/supabase-js", () => {
  const datasets = {
    clusters: [
      { id: "clu_1", rep_article: "art_1" },
      { id: "clu_2", rep_article: "art_2" },
    ],
    cluster_ai_currents: [
      {
        id: "ai_en_1",
        cluster_id: "clu_1",
        lang: "en",
        ai_title: "Pivot Title",
        ai_summary: "Pivot Summary",
        ai_details: "Pivot Details",
        is_current: true,
        created_at: new Date().toISOString(),
      },
      {
        id: "ai_en_2",
        cluster_id: "clu_2",
        lang: "en",
        ai_title: "Rich Pivot Title",
        ai_summary: "Rich Pivot Summary",
        ai_details:
          "This is a sufficiently long pivot details paragraph intended to simulate a real AI-generated explanation. " +
          "It contains background, context, and implications that easily exceed the minimum threshold used by the BFF to decide whether to compose fallback details. " +
          "By being longer than 240 characters, the server should return this translated body as-is without composing a timeline/sources section.",
        is_current: true,
        created_at: new Date().toISOString(),
      },
    ],
    cluster_updates: [
      {
        id: "u1",
        claim: "Initial report",
        summary: "Initial report",
        source_id: null,
        lang: "en",
        happened_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
      {
        id: "u2",
        claim: "Follow-up",
        summary: "Follow-up",
        source_id: null,
        lang: "en",
        happened_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        cluster_id: "clu_2",
      },
    ],
    citations_articles: [
      {
        id: "a_c1",
        title: "Cite A",
        canonical_url: "https://example.com/a",
        url: "https://example.com/a",
        source_id: null,
        published_at: new Date().toISOString(),
        cluster_id: "clu_1",
      },
      {
        id: "a_c2",
        title: "Cite B",
        canonical_url: "https://example.com/b",
        url: "https://example.com/b",
        source_id: null,
        published_at: new Date().toISOString(),
        cluster_id: "clu_1",
      },
      {
        id: "a_c3",
        title: "Cite C",
        canonical_url: "https://example.com/c",
        url: "https://example.com/c",
        source_id: null,
        published_at: new Date().toISOString(),
        cluster_id: "clu_2",
      },
    ],
    coverage_articles: [
      { id: "a1", cluster_id: "clu_1" },
      { id: "a2", cluster_id: "clu_1" },
      { id: "a3", cluster_id: "clu_2" },
    ],
    rep_article: [
      {
        id: "art_1",
        title: "Rep Title",
        snippet: "",
        published_at: new Date().toISOString(),
        language: "en",
        canonical_url: "https://rep",
        url: "https://rep",
        source_id: null,
      },
      {
        id: "art_2",
        title: "Rep Title 2",
        snippet: "",
        published_at: new Date().toISOString(),
        language: "en",
        canonical_url: "https://rep2",
        url: "https://rep2",
        source_id: null,
      },
    ],
  };

  class Builder {
    constructor(table) {
      this.table = table;
      this._filters = {};
      this._limit = null;
    }
    select() {
      return this;
    }
    eq(k, v) {
      this._filters[k] = v;
      return this;
    }
    in() {
      return this;
    }
    order() {
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
        const id = this._filters.id;
        const row = datasets.clusters.find((c) => c.id === id) || null;
        return { data: row, error: null };
      }
      if (this.table === "cluster_ai") {
        if (this._filters.lang) {
          // existingTarget lookup -> none
          return { data: null, error: null };
        }
        // currents
        const list = datasets.cluster_ai_currents.filter(
          (r) => r.cluster_id === this._filters.cluster_id && r.is_current
        );
        return { data: list, error: null };
      }
      if (this.table === "cluster_updates") {
        // Filter by cluster when provided
        const cid = this._filters.cluster_id;
        if (cid) {
          const list = datasets.cluster_updates.filter(
            (u) => (u.cluster_id || "clu_1") === cid
          );
          return { data: list, error: null };
        }
        return { data: datasets.cluster_updates, error: null };
      }
      if (this.table === "articles") {
        if (this._filters.cluster_id) {
          // coverage count or citations list
          const list = datasets.citations_articles
            .filter((a) => a.cluster_id === this._filters.cluster_id)
            .slice(0, this._limit || 1000);
          return { data: list, error: null };
        }
        // rep article by id
        const ids = (this._filters.id && [this._filters.id]) || [];
        const list = ids.length
          ? datasets.rep_article.filter((a) => ids.includes(a.id))
          : datasets.rep_article;
        return { data: list, error: null };
      }
      if (this.table === "sources") {
        return { data: [], error: null };
      }
      if (this.table === "article_media" || this.table === "media_assets") {
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
    if (base(dstLang) === "tr") return `TR:${text}`;
    if (base(dstLang) === "de") return `DE:${text}`;
    return text;
  }),
  translateFieldsCached: vi.fn(
    async ({ title, summary, details }, { dstLang }) => {
      const base = (s) => (s || "").split("-")[0];
      if (base(dstLang) === "tr") {
        return {
          title: `TR:${title}`,
          summary: `TR:${summary}`,
          details: `TR:${details}`,
        };
      }
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

// Patch ensureClusterTextInLang behavior by mocking its underlying queries for cluster_ai currents after import
// Instead, we'll simulate no existing translations and a pivot by intercepting translateNow via translator mocks and shaping responses by augmenting cluster_ai currents call using vi.spyOn is impractical here.
// We'll therefore extend the server's ensure behavior implicitly: we need a pivot row when it queries currents.

// Re-mock createClient to handle cluster_ai currents after import isn't straightforward. For this smoke test, we adapt by providing a second test that injects a pre-translated path via no-op translation.

describe("GET /cluster/:id", () => {
  it("returns 404 for unknown cluster", async () => {
    const res = await step("When I request a non-existing cluster", async () =>
      request(app).get("/cluster/does-not-exist").set("Accept-Language", "en")
    );
    await step("Then status is 404", async () => {
      expect(res.status).toBe(404);
    });
  });

  it("serves cluster with translated text when ?lang=tr-TR", async () => {
    const res = await step(
      "When I request /cluster/clu_1?lang=tr-TR",
      async () => request(app).get("/cluster/clu_1?lang=tr-TR")
    );
    await step(
      "Then response is translated and has timeline/citations",
      async () => {
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("id", "clu_1");
        expect(res.body.language).toBe("tr-TR");
        expect(typeof res.body.title).toBe("string");
        expect(Array.isArray(res.body.timeline)).toBe(true);
        expect(Array.isArray(res.body.citations)).toBe(true);
        const hasTR = [res.body.title, res.body.summary, res.body.ai_details]
          .filter(Boolean)
          .some((t) => String(t).includes("TR:"));
        expect(hasTR).toBe(true);
      }
    );
  });

  it("returns translated pivot ai_details when it's already rich (no composition)", async () => {
    const res = await step(
      "When I request /cluster/clu_2?lang=tr-TR (rich pivot details)",
      async () => request(app).get("/cluster/clu_2?lang=tr-TR")
    );
    await step(
      "Then ai_details is translated directly without composition",
      async () => {
        expect(res.status).toBe(200);
        expect(res.body.language).toBe("tr-TR");
        expect(typeof res.body.ai_details).toBe("string");
        expect(res.body.ai_details.startsWith("TR:")).toBe(true);
        expect(res.body.ai_details.includes("Timeline updates:")).toBe(false);
        expect(res.body.ai_details.includes("Sources:")).toBe(false);
      }
    );
  });
});
