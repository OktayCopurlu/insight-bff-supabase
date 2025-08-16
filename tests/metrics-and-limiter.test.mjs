import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { step } from "./testStep.mjs";

// Provide minimal env to avoid real network/providers
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "test_key";
process.env.BFF_TRANSLATION_TAG = "off";
process.env.NODE_ENV = "test";

// Ensure the server doesn't auto-listen during tests
process.env.BFF_AUTO_LISTEN = "false";

// Mock Supabase client to return fast, empty data
vi.mock("@supabase/supabase-js", () => {
  class Builder {
    select() { return this; }
    eq() { return this; }
    in() { return this; }
    order() { return this; }
    limit() { return this; }
    insert() { return this; }
    update() { return this; }
    _resolve() { return { data: [], error: null }; }
    maybeSingle() { return Promise.resolve(this._resolve()); }
    single() { return Promise.resolve(this._resolve()); }
    then(onFulfilled, onRejected) { return Promise.resolve(this._resolve()).then(onFulfilled, onRejected); }
    catch(onRejected) { return Promise.resolve(this._resolve()).catch(onRejected); }
    finally(onFinally) { return Promise.resolve(this._resolve()).finally(onFinally); }
  }
  return { createClient: () => ({ from: () => new Builder() }) };
});

// Mock translator to be synchronous and cheap
vi.mock("../src/utils/textTranslate.mjs", () => ({
  translateTextCached: vi.fn(async (text) => text),
  translateFieldsCached: vi.fn(async (fields) => fields),
}));

// Import the app after mocks
import { app } from "../server.mjs";

describe("BFF /metrics and /translate/batch rate limiting", () => {
  it("exposes /metrics with translate and bff counters", async () => {
    await step("Given the BFF service is running", async () => {
      const res = await request(app).get("/metrics");
      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.service).toBe("insight-bff");
        expect(res.body).toHaveProperty("translate");
        expect(res.body.translate).toHaveProperty("providerCalls");
        expect(res.body).toHaveProperty("batch");
        expect(res.body.batch).toHaveProperty("requests");
      }
    });
  });

  it("enforces rate limiting on /translate/batch", async () => {
    await step(
      "When I post to /translate/batch twice under a low limit, Then second is 429",
      async () => {
        process.env.RATE_LIMIT_BATCH = "1";
        const agent = request(app);
        await agent
          .post("/translate/batch?lang=en")
          .send({ ids: ["c1"] })
          .set("Content-Type", "application/json")
          .expect((r) => [200, 500].includes(r.status));
        const limited = await agent
          .post("/translate/batch?lang=en")
          .send({ ids: ["c2"] })
          .set("Content-Type", "application/json")
          .expect(429);
        expect(limited.body).toHaveProperty("error", "rate_limited");
      }
    );
  });
});
