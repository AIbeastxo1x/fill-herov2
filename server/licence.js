// Licence keys for the Chrome extension. Keys are issued by hand from the web app.
// Only a hash of each key is stored, so the server cannot show a key again after it is issued.
import crypto from "node:crypto";

// No easily confused characters (no 0, O, 1, I, L).
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function generateKey() {
  const bytes = crypto.randomBytes(20);
  let body = "";
  for (const b of bytes) body += ALPHABET[b % ALPHABET.length];
  return `FH-${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10, 15)}-${body.slice(15, 20)}`;
}

export function hashKey(key) {
  return crypto.createHash("sha256").update(String(key).trim().toUpperCase()).digest("hex");
}

// days: how long the key lasts. 0 means no expiry.
// Returns the new licence (with its key, shown once) and the list with the key left out.
export function issueLicence(licences, customer, days = 0, now = Date.now()) {
  const key = generateKey();
  const expiresAt = days > 0 ? now + days * 24 * 60 * 60 * 1000 : null;
  const licence = { id: crypto.randomBytes(6).toString("hex"), customer, keyHash: hashKey(key), status: "active", issuedAt: now, expiresAt };
  return { key, licence, licences: [...licences, licence] };
}

export function isLicenceExpired(licence, now = Date.now()) {
  return Boolean(licence.expiresAt) && now >= licence.expiresAt;
}

export function revokeLicence(licences, id, now = Date.now()) {
  return licences.map((l) => (l.id === id && l.status === "active" ? { ...l, status: "revoked", revokedAt: now } : l));
}

// Checks a key against the stored hashes. Returns the matching licence or null.
export function findLicence(licences, key) {
  const given = Buffer.from(hashKey(key), "hex");
  for (const l of licences) {
    const stored = Buffer.from(l.keyHash, "hex");
    if (stored.length === given.length && crypto.timingSafeEqual(stored, given)) return l;
  }
  return null;
}

// Keeps a short history of failed attempts per address, so keys cannot be guessed.
export function makeAttemptLimiter({ max = 30, windowMs = 10 * 60 * 1000 } = {}) {
  const hits = new Map();
  return {
    blocked(ip, now = Date.now()) {
      const h = hits.get(ip);
      if (!h || now > h.resetAt) return false;
      return h.count >= max;
    },
    failed(ip, now = Date.now()) {
      const h = hits.get(ip);
      if (!h || now > h.resetAt) hits.set(ip, { count: 1, resetAt: now + windowMs });
      else h.count += 1;
    },
  };
}
