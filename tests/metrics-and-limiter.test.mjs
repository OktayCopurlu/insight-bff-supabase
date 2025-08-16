import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../server.mjs";
import { step } from "./testStep.mjs";

// Ensure the server doesn't auto-listen during tests
process.env.BFF_AUTO_LISTEN = "false";

describe("BFF /metrics and /translate/batch rate limiting", () => {
  it("exposes /metrics with translate and bff counters", async () => {
    await step("Given the BFF service is running", async () => {
      const res = await request(app).get("/metrics").expect(200);
      expect(res.body.service).toBe("insight-bff");
      expect(res.body).toHaveProperty("translate");
      expect(res.body.translate).toHaveProperty("providerCalls");
      expect(res.body).toHaveProperty("batch");
      expect(res.body.batch).toHaveProperty("requests");
    });
  });

  it("enforces rate limiting on /translate/batch", async () => {
    await step("When I post to /translate/batch twice under a low limit, Then second is 429", async () => {
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
    });
  });
});
