import { describe, it, expect } from "vitest";
import {
  translateTextCached,
  translateMetrics,
} from "../src/utils/textTranslate.mjs";
import { step } from "./testStep.mjs";

// Ensure no provider is used so we only exercise cache paths
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "";
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
process.env.BFF_TRANSLATION_TAG = "off";

describe("translateMetrics counters", () => {
  it("increments cacheMisses then cacheHits for repeated calls", async () => {
    const baseMisses = translateMetrics.cacheMisses;
    const baseHits = translateMetrics.cacheHits;
    const text = `hello world ${Date.now()}`; // unique key per run
    const opts = { srcLang: "en", dstLang: "tr" };

    const first = await step(
      "When I translate a unique text (miss)",
      async () => translateTextCached(text, opts)
    );
    await step(
      "Then the first result is a string and misses increase",
      async () => {
        expect(typeof first).toBe("string");
        expect(translateMetrics.cacheMisses).toBeGreaterThan(baseMisses);
      }
    );

    const second = await step(
      "When I translate the same text again (hit)",
      async () => translateTextCached(text, opts)
    );
    await step("Then it returns from cache and hits increase", async () => {
      expect(second).toBe(first);
      expect(translateMetrics.cacheHits).toBeGreaterThan(baseHits);
      expect(translateMetrics.providerCalls).toBeGreaterThanOrEqual(0);
    });
  });
});
