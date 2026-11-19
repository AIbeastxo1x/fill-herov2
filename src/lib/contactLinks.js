// Find contact-page URLs on the same host as the base URL.

const CONTACT_TEXT = /contact|get in touch/i;
const FALLBACK_PATHS = ["contact", "contact-us"];

// "www.example.com" and "example.com" are the same site.
const sameSite = (a, b) => a.replace(/^www\./, "") === b.replace(/^www\./, "");

export function findContactLinks(links, baseUrl) {
  const base = new URL(baseUrl);
  const seen = new Set();
  const out = [];

  for (const { href, text } of links) {
    if (!CONTACT_TEXT.test(String(text ?? ""))) continue;
    let abs;
    try {
      abs = new URL(href, base);
    } catch {
      continue;
    }
    if (!sameSite(abs.host, base.host)) continue;
    abs.hash = "";
    const s = abs.toString();
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }

  if (out.length > 0) return out;
  return FALLBACK_PATHS.map((p) => new URL(`/${p}`, base).toString());
}
