// Normalize user-entered domains into https URLs and hostnames.

export function normalizeDomain(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, reason: "empty" };

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }

  const host = url.hostname.toLowerCase();
  if (!host) return { ok: false, reason: "no-host" };

  // Local test servers keep their scheme and port; real domains always use https.
  if (host === "localhost" || host === "127.0.0.1") {
    const origin = `${url.protocol}//${url.host}`;
    return { ok: true, url: `${origin}/`, host: url.host };
  }

  if (!host.includes(".")) return { ok: false, reason: "no-host" };
  return { ok: true, url: `https://${host}/`, host };
}

export function parseDomainList(text) {
  return String(text ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((input) => {
      const r = normalizeDomain(input);
      return r.ok ? { input, ok: true, url: r.url, host: r.host } : { input, ok: false, reason: r.reason };
    });
}
