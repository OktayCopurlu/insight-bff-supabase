// Centralized Gemini config + helpers (new @google/genai SDK)
// Supports googleSearch grounding and legacy dynamic retrieval for 1.5

import { GoogleGenAI, DynamicRetrievalConfigMode } from "@google/genai";

let _client = null;

export function getGeminiClient() {
  if (_client) return _client;
  const apiKey = process.env.LLM_API_KEY || process.env.GEMINI_API_KEY || "";
  if (!apiKey) return null;
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

// Model id helper
export function getModelId(modelId) {
  return (
    modelId ||
    process.env.LLM_MODEL ||
    process.env.GEMINI_MODEL ||
    "gemini-1.5-flash"
  );
}

// Generate grounded content with optional Google Search tool and/or legacy dynamic retrieval.
// opts: {
//   model?: string,
//   useGoogleSearch?: boolean,
//   dynamicRetrieval?: { enabled?: boolean, threshold?: number }
//   systemInstruction?: string,
//   temperature?: number
// }
export async function generateWithSearch(prompt, opts = {}) {
  const client = getGeminiClient();
  if (!client) throw new Error("Gemini not configured");
  const model = getModelId(opts.model);

  // Build tools per mode
  const wantSearch = !!opts.useGoogleSearch;
  const wantLegacy = !wantSearch && !!opts.dynamicRetrieval?.enabled;
  const buildTools = (mode) => {
    if (mode === "search") return [{ googleSearch: {} }];
    if (mode === "legacy")
      return [
        {
          googleSearchRetrieval: {
            dynamicRetrievalConfig: {
              mode:
                opts.dynamicRetrieval?.mode === "required"
                  ? DynamicRetrievalConfigMode.MODE_REQUIRED
                  : DynamicRetrievalConfigMode.MODE_DYNAMIC,
              dynamicThreshold:
                typeof opts.dynamicRetrieval?.threshold === "number"
                  ? opts.dynamicRetrieval.threshold
                  : 0.7,
            },
          },
        },
      ];
    return [];
  };

  async function runOnce(toolMode) {
    return client.models.generateContent({
      model,
      contents: prompt,
      config: {
        tools: buildTools(toolMode),
        ...(typeof opts.temperature === "number"
          ? { temperature: opts.temperature }
          : {}),
        ...(opts.systemInstruction
          ? { systemInstruction: opts.systemInstruction }
          : {}),
      },
    });
  }

  let res;
  let modeUsed = wantSearch ? "search" : wantLegacy ? "legacy" : "none";
  try {
    res = await runOnce(modeUsed);
  } catch (e) {
    const msg = String(e?.message || "");
    const isSearchUnsupported =
      wantSearch &&
      (msg.includes("google_search is not supported") ||
        msg.includes(
          "google_search is not supported; please use google_search_retrieval"
        ) ||
        (msg.includes("INVALID_ARGUMENT") && msg.includes("google_search")));
    if (isSearchUnsupported) {
      // Retry using legacy dynamic retrieval
      modeUsed = "legacy";
      res = await runOnce(modeUsed);
    } else {
      throw e;
    }
  }
  // Return unified shape
  const text =
    res?.text || res?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const grounding = res?.candidates?.[0]?.groundingMetadata || null;
  return { raw: res, text, grounding, mode: modeUsed };
}

// Extract simple list of web URIs from grounding metadata
export function extractGroundingLinks(groundingMetadata) {
  const chunks = groundingMetadata?.groundingChunks || [];
  const links = chunks
    .map((c) => (c?.web?.uri ? c.web.uri : null))
    .filter(Boolean);
  return Array.from(new Set(links));
}

// Plain generation without tools (e.g., translations/JSON shaping)
export async function generatePlain(prompt, opts = {}) {
  const client = getGeminiClient();
  if (!client) throw new Error("Gemini not configured");
  const model = getModelId(opts.model);
  const res = await client.models.generateContent({
    model,
    contents: prompt,
    config: {
      ...(typeof opts.temperature === "number"
        ? { temperature: opts.temperature }
        : {}),
      ...(typeof opts.maxOutputTokens === "number"
        ? { maxOutputTokens: opts.maxOutputTokens }
        : {}),
    },
  });
  const text =
    res?.text || res?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return { raw: res, text };
}
