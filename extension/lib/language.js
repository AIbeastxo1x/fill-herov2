// Language helpers. Field labels are matched by keyword in fieldMap.js; this file
// decides when the message text itself must be translated into the site's language.

// "fr-FR" -> "fr", "de" -> "de", missing or unusable -> null.
export function siteLanguage(htmlLang) {
  const m = /^([a-z]{2,3})(?:[-_]|$)/i.exec(String(htmlLang ?? "").trim());
  return m ? m[1].toLowerCase() : null;
}

// Translate only when the page is in a known non-English language.
export function needsTranslation(lang) {
  return !!lang && lang !== "en";
}
