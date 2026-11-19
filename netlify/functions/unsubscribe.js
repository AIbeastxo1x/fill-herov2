// Public unsubscribe page: /unsubscribe?t=... Forwards to the Fill Hero server, which checks the signed link.
// No sign-in is needed, because the signature on the link is the proof.
export async function handler(event) {
  const server = (process.env.FILLHERO_SERVER_URL || "").replace(/\/+$/, "");
  if (!server) {
    return { statusCode: 500, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Not configured." };
  }
  const query = event.rawQuery ? `?${event.rawQuery}` : "";
  const method = event.httpMethod === "POST" ? "POST" : "GET";
  try {
    const res = await fetch(`${server}/unsubscribe${query}`, { method });
    return {
      statusCode: res.status,
      headers: { "content-type": res.headers.get("content-type") || "text/html; charset=utf-8", "cache-control": "no-store" },
      body: await res.text(),
    };
  } catch {
    return { statusCode: 502, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Could not reach the server. Try again later." };
  }
}
