// Email extraction helpers. Pure functions, so they can be unit tested.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// Image and asset file names such as logo@2x.png look like addresses; drop them.
const NOT_EMAIL = /\.(png|jpe?g|gif|svg|webp|ico|css|js)$/i;

// Returns the unique, lower-cased email addresses found in a string of page source or text.
export function extractEmails(text) {
  const source = String(text ?? "").replace(/&#64;|&commat;|&#x40;/gi, "@");
  const found = new Set();
  for (const match of source.match(EMAIL) ?? []) {
    const email = match.toLowerCase().replace(/^\.+|\.+$/g, "");
    if (!NOT_EMAIL.test(email)) found.add(email);
  }
  return [...found];
}

export function emailsToCsv(emails) {
  const cols = ["host", "email", "pageUrl", "at"];
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = emails.map((e) => cols.map((c) => esc(c === "at" ? new Date(e.at).toISOString() : e[c])).join(","));
  return [cols.join(","), ...rows].join("\n");
}
