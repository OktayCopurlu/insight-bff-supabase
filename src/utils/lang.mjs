// Language utilities for BFF (testable)

export function normalizeBcp47(tag) {
  if (!tag || typeof tag !== "string") return null;
  const t = tag.trim().replace(/_/g, "-");
  if (!t) return null;
  const parts = t.split("-");
  if (!parts.length) return null;
  const lang = parts[0].toLowerCase();
  const rest = parts
    .slice(1)
    .map((p, i) => (i === 0 && p.length === 2 ? p.toUpperCase() : p))
    .join("-");
  return rest ? `${lang}-${rest}` : lang;
}

export function pickFromAcceptLanguage(header) {
  if (!header) return null;
  const first = header.split(",")[0]?.trim();
  return normalizeBcp47(first);
}

export function isRtlLang(tag) {
  const l = (tag || "").toLowerCase();
  return ["ar", "he", "fa", "ur"].some(
    (rtl) => l === rtl || l.startsWith(rtl + "-")
  );
}

export function dirFor(lang) {
  return isRtlLang(lang) ? "rtl" : "ltr";
}

export function baseLang(lang) {
  const n = normalizeBcp47(lang) || "en";
  return n.split("-")[0];
}

// Framework-agnostic negotiation: takes queryLang and acceptLanguage header value
export function negotiateLanguageSimple(queryLang, acceptLanguageHeader) {
  const q = normalizeBcp47(queryLang);
  if (q) return q;
  const h = pickFromAcceptLanguage(acceptLanguageHeader);
  return h || "en";
}
