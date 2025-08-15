import { describe, it, expect } from "vitest";
import {
  normalizeBcp47,
  pickFromAcceptLanguage,
  isRtlLang,
  dirFor,
  negotiateLanguageSimple,
} from "../src/utils/lang.mjs";

describe("lang utils", () => {
  it("normalizes BCP-47", () => {
    expect(normalizeBcp47("EN_us")).toBe("en-US");
    expect(normalizeBcp47("tr")).toBe("tr");
    expect(normalizeBcp47("de-ch")).toBe("de-CH");
  });
  it("picks from Accept-Language", () => {
    expect(pickFromAcceptLanguage("de-CH,de;q=0.8,en;q=0.5")).toBe("de-CH");
    expect(pickFromAcceptLanguage("tr, en;q=0.9")).toBe("tr");
  });
  it("rtl detection and dir", () => {
    expect(isRtlLang("ar")).toBe(true);
    expect(dirFor("ar")).toBe("rtl");
    expect(isRtlLang("de")).toBe(false);
    expect(dirFor("de")).toBe("ltr");
  });
  it("negotiation simple", () => {
    expect(negotiateLanguageSimple("fr", "en-US,en;q=0.8")).toBe("fr");
    expect(negotiateLanguageSimple("", "de-CH,de;q=0.8")).toBe("de-CH");
    expect(negotiateLanguageSimple("", "")).toBe("en");
  });
});
