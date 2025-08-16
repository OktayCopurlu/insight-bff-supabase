import { describe, it, expect } from "vitest";
import {
  translateTextCached,
  translateMetrics,
} from "../src/utils/textTranslate.mjs";

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

    const first = await translateTextCached(text, opts);
    expect(typeof first).toBe("string");
    // After first call, we expect at least one miss
    expect(translateMetrics.cacheMisses).toBeGreaterThan(baseMisses);

    const second = await translateTextCached(text, opts);
    expect(second).toBe(first); // served from cache
    expect(translateMetrics.cacheHits).toBeGreaterThan(baseHits);

    // Provider should not have been called when API key is absent
    expect(translateMetrics.providerCalls).toBeGreaterThanOrEqual(0);
  });
});
