// Sign-in cookie helpers, shared by the Netlify functions.
// The cookie holds an HMAC of a fixed phrase, keyed with FILLHERO_TOKEN. The token itself is never sent to the browser.
import crypto from "node:crypto";

export const COOKIE = "fh_session";
export const MAX_AGE = 8 * 60 * 60; // eight hours

// The cookie value depends on SESSION_VERSION (default "1"). Changing it in Netlify signs out every browser at once.
export function sessionValue(secret, version = "1") {
  return crypto.createHmac("sha256", secret).update(`fillhero-session-v1:${version}`).digest("hex");
}

export function sessionVersion(env = process.env) {
  return String(env.SESSION_VERSION || "1");
}

// Compare two strings in constant time. Hashing first makes the lengths equal.
export function safeEqual(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

export function cookieValue(headers = {}, name = COOKIE) {
  const raw = headers.cookie || headers.Cookie || "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

export function isSignedIn(headers, env = process.env) {
  if (!env.FILLHERO_TOKEN) return false;
  const value = cookieValue(headers);
  return value !== "" && safeEqual(value, sessionValue(env.FILLHERO_TOKEN, sessionVersion(env)));
}

export function sessionCookie(env = process.env) {
  return `${COOKIE}=${sessionValue(env.FILLHERO_TOKEN, sessionVersion(env))}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${MAX_AGE}`;
}

export function clearCookie() {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}
