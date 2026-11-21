// Proxy from the web page to the Fill Hero server on Render.
// The server token stays here, in Netlify's environment, and is never sent to the browser.
// Needs FILLHERO_SERVER_URL (for example https://fill-herov2.onrender.com) and FILLHERO_TOKEN.
import { isSignedIn } from "../lib/session.js";

// Only these routes are forwarded. Anything else is refused.
const ALLOWED = /^(state|live|profile|start|stop|clear|campaign|campaign\/(start|stop|suppress)|smtp|smtp\/test|contacts|contacts\/(import|clear)|licences|licences\/[0-9a-f]+\/revoke|files\/(emails\.txt|captcha_domains\.txt))$/;
const METHODS = new Set(["GET", "PUT", "POST"]);

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

export async function handler(event) {
  if (!isSignedIn(event.headers)) return json(401, { error: "unauthorized" });

  const env = process.env;
  const server = (env.FILLHERO_SERVER_URL || "").replace(/\/+$/, "");
  if (!server || !env.FILLHERO_TOKEN) return json(500, { error: "not-configured" });

  const route = (event.path || "").split("/api/")[1] || "";
  if (!ALLOWED.test(route) || !METHODS.has(event.httpMethod)) return json(404, { error: "not-found" });

  const rawBody = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : undefined;
  const query = event.rawQuery ? `?${event.rawQuery}` : "";

  let res;
  try {
    res = await fetch(`${server}/api/${route}${query}`, {
      method: event.httpMethod,
      headers: {
        authorization: `Bearer ${env.FILLHERO_TOKEN}`,
        ...(rawBody ? { "content-type": "application/json" } : {}),
      },
      body: rawBody,
    });
  } catch {
    return json(502, { error: "server-unreachable" });
  }

  const headers = { "content-type": res.headers.get("content-type") || "application/json", "cache-control": "no-store" };
  const disposition = res.headers.get("content-disposition");
  if (disposition) headers["content-disposition"] = disposition;
  return { statusCode: res.status, headers, body: await res.text() };
}
