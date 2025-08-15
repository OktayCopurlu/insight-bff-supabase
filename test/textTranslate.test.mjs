import { describe, it, expect, vi, afterEach } from "vitest";

// Helper to load module fresh with stubbed env and a mock Gemini client
async function loadTranslatorWithMock({ env = {}, mockImpl } = {}) {
  vi.resetModules();
  // Stub important envs before import (module reads them on load)
  const defaults = {
    LLM_API_KEY: "test-key",
    LLM_MODEL: "gemini-1.5-flash",
    MT_TIMEOUT_MS: "500",
    MT_RETRIES: "0",
    MT_BACKOFF_MS: "10",
    MT_CHUNK_THRESHOLD: "1200",
    MT_CHUNK_MAX: "1600",
    BFF_TRANSLATION_TAG: "on",
  };
  for (const [k, v] of Object.entries({ ...defaults, ...env })) {
    process.env[k] = v;
  }

  // Track mock state on globalThis for assertions
  globalThis.__gemini_calls = 0;
  globalThis.__lastPrompt = null;

  const impl =
    mockImpl ||
    (async (prompt) => {
      globalThis.__gemini_calls++;
      globalThis.__lastPrompt = prompt;
      return {
        response: {
          text: () => "MOCK_TRANSLATION",
        },
      };
    });

  vi.mock("@google/generative-ai", () => {
    class GoogleGenerativeAI {
      constructor(_key) {}
      getGenerativeModel(_opts) {
        return {
          generateContent: impl,
        };
      }
    }
    return { GoogleGenerativeAI };
  });

  const mod = await import("../src/utils/textTranslate.mjs");
  return mod;
}

describe("textTranslate.mjs (Gemini)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps de-CH to German in the Gemini prompt and returns translated text", async () => {
    const { translateTextCached } = await loadTranslatorWithMock();
    const out = await translateTextCached("Hello world", {
      srcLang: "en",
      dstLang: "de-CH",
    });
    expect(out).toBe("MOCK_TRANSLATION");
    expect(globalThis.__lastPrompt).toMatch(/to German/i);
    expect(globalThis.__gemini_calls).toBe(1);
  });

  it("reuses cache across regional variants (de-CH and de-DE)", async () => {
    const { translateTextCached } = await loadTranslatorWithMock();
    const text = "Cache me";
    const out1 = await translateTextCached(text, {
      srcLang: "en",
      dstLang: "de-CH",
    });
    const out2 = await translateTextCached(text, {
      srcLang: "en",
      dstLang: "de-DE",
    });
    expect(out1).toBe("MOCK_TRANSLATION");
    expect(out2).toBe("MOCK_TRANSLATION");
    // Only the first call should hit Gemini due to normalized cache key
    expect(globalThis.__gemini_calls).toBe(1);
  });

  it("chunks long text and calls Gemini per chunk", async () => {
    const { translateTextCached } = await loadTranslatorWithMock({
      env: { MT_CHUNK_THRESHOLD: "10", MT_CHUNK_MAX: "10" },
      mockImpl: async (prompt) => {
        globalThis.__gemini_calls++;
        globalThis.__lastPrompt = prompt;
        return { response: { text: () => "X" } };
      },
    });
    const long = "A sentence. Another sentence. Third one."; // > 10 chars
    const out = await translateTextCached(long, {
      srcLang: "en",
      dstLang: "de-CH",
    });
    // Expect multiple chunks concatenated
    expect(globalThis.__gemini_calls).toBeGreaterThanOrEqual(3);
    expect(out.length).toBe(globalThis.__gemini_calls); // each chunk returns 'X'
  });

  it("returns fallback marker on timeout after retries", async () => {
    const never = () => new Promise(() => {}); // never resolves
    const { translateTextCached } = await loadTranslatorWithMock({
      env: { MT_TIMEOUT_MS: "50", MT_RETRIES: "0", BFF_TRANSLATION_TAG: "on" },
      mockImpl: async () => never(),
    });
    const src = "Hello";
    const out = await translateTextCached(src, {
      srcLang: "en",
      dstLang: "de-CH",
    });
    expect(out).toBe(src + " [translated]");
  });
});
