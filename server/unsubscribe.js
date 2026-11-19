// One-click unsubscribe links. Each link carries the recipient's address and a signature made with
// FILLHERO_TOKEN, so nobody can unsubscribe someone else or make up a link.
import crypto from "node:crypto";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sign(id, secret) {
  return crypto.createHmac("sha256", secret).update(`unsubscribe:${id}`).digest("base64url");
}

export function makeUnsubscribeToken(email, secret) {
  const id = Buffer.from(String(email).toLowerCase(), "utf8").toString("base64url");
  return `${id}.${sign(id, secret)}`;
}

// Returns the address the token is for, or null if the token is missing, altered or not valid.
export function readUnsubscribeToken(token, secret) {
  if (!secret || typeof token !== "string") return null;
  const [id, sig, extra] = token.split(".");
  if (!id || !sig || extra !== undefined) return null;
  const expected = Buffer.from(sign(id, secret));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  const email = Buffer.from(id, "base64url").toString("utf8");
  return EMAIL_RE.test(email) ? email : null;
}

export function unsubscribeUrl(baseUrl, email, secret) {
  return `${String(baseUrl).replace(/\/+$/, "")}/unsubscribe?t=${makeUnsubscribeToken(email, secret)}`;
}
