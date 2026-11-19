// Sign-in for the web page: /auth/login, /auth/logout, /auth/check.
// Needs SITE_PASSWORD (the password you type) and FILLHERO_TOKEN (the server token) set in Netlify.
import { isSignedIn, safeEqual, sessionCookie, clearCookie } from "../lib/session.js";

const json = (statusCode, body, extraHeaders = {}) => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store", ...extraHeaders },
  body: JSON.stringify(body),
});

export async function handler(event) {
  const action = (event.path || "").split("/").pop();

  if (action === "check") {
    return isSignedIn(event.headers) ? json(200, { ok: true }) : json(401, { ok: false });
  }

  if (action === "logout") {
    return json(200, { ok: true }, { "set-cookie": clearCookie() });
  }

  if (action === "login") {
    if (event.httpMethod !== "POST") return json(405, { error: "method-not-allowed" });
    const env = process.env;
    if (!env.FILLHERO_TOKEN || !env.SITE_PASSWORD) return json(500, { error: "not-configured" });

    let password = "";
    try {
      password = JSON.parse(event.body || "{}").password || "";
    } catch {
      password = "";
    }
    await new Promise((resolve) => setTimeout(resolve, 800)); // slows down password guessing
    if (!password || !safeEqual(password, env.SITE_PASSWORD)) return json(401, { error: "wrong-password" });
    return json(200, { ok: true }, { "set-cookie": sessionCookie(env) });
  }

  return json(404, { error: "not-found" });
}
