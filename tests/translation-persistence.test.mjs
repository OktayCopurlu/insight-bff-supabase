import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Provide minimal env required by server early
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "test_key";
process.env.BFF_TRANSLATION_TAG = "off";
process.env.NODE_ENV = "test";

// --- In-memory datasets and call tracking ---
const datasets = {
  clusters: [{ id: "clu_x", rep_article: "art_x" }],
  rep_article: [
    {
      id: "art_x",
      title: "Rep X",
      snippet: "",
      published_at: new Date().toISOString(),
      language: "en",
      canonical_url: "https://rep/x",
      url: "https://rep/x",
      source_id: null,
    },
  ],
  cluster_ai_currents: [
    {
      id: "ai_en_x",
      cluster_id: "clu_x",
      lang: "en",
      ai_title: "Pivot X Title",
      ai_summary: "Pivot X Summary",
      ai_details: "Pivot X Details",
      is_current: true,
      created_at: new Date().toISOString(),
      model: "seed",
    },
  ],
  cluster_ai_targets: [],
  coverage_articles: [{ id: "cx1", cluster_id: "clu_x" }],
};
const calls = {
  inserts: [],
  updates: [],
};

// Robust Supabase mock with awaitable query builder that records writes
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
    insert(obj) {
      calls.inserts.push({ table: this.table, values: obj });
      return this;
    }
    update(obj) {
      calls.updates.push({
        table: this.table,
        values: obj,
        where: this._filters,
      });
      return this;
    }
    _resolve() {
      if (this.table === "clusters") {
        if (this._filters.id) {
          const row =
            datasets.clusters.find((c) => c.id === this._filters.id) || null;
          return { data: row, error: null };
        }
        return {
          data: datasets.clusters.slice(0, this._limit || undefined),
          error: null,
        };
      }
      if (this.table === "articles") {
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
          const row = datasets.cluster_ai_targets.find(
            (r) => r.cluster_id === cid && r.lang === lang && r.is_current
          );
          return { data: row || null, error: null };
        }
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
      if (this.table === "app_markets") {
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

// Mock translators
const tfcSpy = vi.fn(async ({ title, summary, details }) => ({
  title: `TR:${title}`,
  summary: `TR:${summary}`,
  details: `TR:${details}`,
}));
vi.mock("../src/utils/textTranslate.mjs", () => ({
  translateTextCached: vi.fn(async (text, { dstLang }) => text),
  translateFieldsCached: (...args) => tfcSpy(...args),
}));

// Now import the app (after mocks)
import { app } from "../server.mjs";

describe("translation persistence and base fallback", () => {
  beforeEach(() => {
    calls.inserts.length = 0;
    calls.updates.length = 0;
    tfcSpy.mockClear();
    // reset datasets to initial
    datasets.cluster_ai_targets.length = 0;
    datasets.cluster_ai_currents.splice(
      0,
      datasets.cluster_ai_currents.length,
      {
        id: "ai_en_x",
        cluster_id: "clu_x",
        lang: "en",
        ai_title: "Pivot X Title",
        ai_summary: "Pivot X Summary",
        ai_details: "Pivot X Details",
        is_current: true,
        created_at: new Date().toISOString(),
        model: "seed",
      }
    );
  });

  it("GET /cluster/:id?lang=tr writes a target row when missing (write-through)", async () => {
    const res = await request(app).get("/cluster/clu_x?lang=tr");
    expect(res.status).toBe(200);
    // Response should be in requested language and contain translated fields
    expect(res.body.language).toBe("tr");
    expect(res.body.title.startsWith("TR:")).toBe(true);
    expect(res.body.summary.startsWith("TR:")).toBe(true);
    // One insert into cluster_ai with target lang
    const ins = calls.inserts.filter((c) => c.table === "cluster_ai");
    expect(ins.length).toBeGreaterThanOrEqual(1);
    const payload = ins[0].values;
    expect(payload.lang).toBe("tr");
    expect(typeof payload.ai_title).toBe("string");
  });

  it("GET /cluster/:id?lang=de-CH reuses base 'de' without calling translateFieldsCached", async () => {
    // change pivot to de
    datasets.cluster_ai_currents[0].lang = "de";
    datasets.cluster_ai_currents[0].ai_title = "Pivot DE Title";
    datasets.cluster_ai_currents[0].ai_summary = "Pivot DE Summary";
    datasets.cluster_ai_currents[0].ai_details = "Pivot DE Details";

    const res = await request(app).get("/cluster/clu_x?lang=de-CH");
    expect(res.status).toBe(200);
    expect(res.body.language).toBe("de-CH");
    // Should not have called provider for same base language
    expect(tfcSpy).not.toHaveBeenCalled();
    // But it still persists a target row for de-CH
    const ins = calls.inserts.filter((c) => c.table === "cluster_ai");
    expect(ins.length).toBeGreaterThanOrEqual(1);
    expect(ins[0].values.lang).toBe("de-CH");
  });

  it("POST /translate/batch persists results for all ids", async () => {
    // Also add a second cluster
    datasets.clusters.push({ id: "clu_y", rep_article: "art_x" });
    datasets.cluster_ai_currents.push({
      id: "ai_en_y",
      cluster_id: "clu_y",
      lang: "en",
      ai_title: "Pivot Y Title",
      ai_summary: "Pivot Y Summary",
      ai_details: "Pivot Y Details",
      is_current: true,
      created_at: new Date().toISOString(),
      model: "seed",
    });

    const res = await request(app)
      .post("/translate/batch?lang=tr")
      .send({ ids: ["clu_x", "clu_y"] });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results.map((r) => r.id).sort()).toEqual([
      "clu_x",
      "clu_y",
    ]);
    const ins = calls.inserts.filter((c) => c.table === "cluster_ai");
    // One per cluster (or more if refresh flow happens); at least 2
    expect(ins.length).toBeGreaterThanOrEqual(2);
    // cleanup: remove y
    datasets.clusters.pop();
    datasets.cluster_ai_currents = datasets.cluster_ai_currents.filter(
      (r) => r.cluster_id !== "clu_y"
    );
  });
});
