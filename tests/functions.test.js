// Tests for the Netlify sign-in and proxy functions, against a fake Fill Hero server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const TOKEN = "server-token-for-tests-0123456789";
const PASSWORD = "site-password-for-tests";

let fake;
let auth;
let api;
const seen = [];

before(async () => {
  fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.url.startsWith("/api/files/emails.txt")) {
        res.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="emails.txt"' });
        return res.end("a@b.com\tb.com\r\n");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, running: false }));
    });
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  process.env.FILLHERO_SERVER_URL = `http://127.0.0.1:${fake.address().port}`;
  process.env.FILLHERO_TOKEN = TOKEN;
  process.env.SITE_PASSWORD = PASSWORD;
  auth = (await import("../netlify/functions/auth.js")).handler;
  api = (await import("../netlify/functions/api.js")).handler;
});

after(() => fake.close());

const ev = (path, extra = {}) => ({ path, httpMethod: "GET", headers: {}, rawQuery: "", body: null, ...extra });

function cookieFrom(res) {
  const header = res.headers["set-cookie"];
  return header.split(";")[0]; // fh_session=...
}

test("check is refused without a sign-in", async () => {
  const res = await auth(ev("/auth/check"));
  assert.equal(res.statusCode, 401);
});

test("wrong password is refused and sets no cookie", async () => {
  const res = await auth(ev("/auth/login", { httpMethod: "POST", body: JSON.stringify({ password: "nope" }) }));
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers["set-cookie"], undefined);
});

test("correct password sets an HttpOnly cookie that does not contain the token", async () => {
  const res = await auth(ev("/auth/login", { httpMethod: "POST", body: JSON.stringify({ password: PASSWORD }) }));
  assert.equal(res.statusCode, 200);
  const header = res.headers["set-cookie"];
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Strict/);
  assert.ok(!header.includes(TOKEN));
});

test("api is refused without a sign-in and reaches nothing", async () => {
  const before = seen.length;
  const res = await api(ev("/api/state"));
  assert.equal(res.statusCode, 401);
  assert.equal(seen.length, before);
});

test("signed-in browser can check, call the server with the token, and sign out", async () => {
  const login = await auth(ev("/auth/login", { httpMethod: "POST", body: JSON.stringify({ password: PASSWORD }) }));
  const headers = { cookie: cookieFrom(login) };

  assert.equal((await auth(ev("/auth/check", { headers }))).statusCode, 200);

  const state = await api(ev("/api/state", { headers }));
  assert.equal(state.statusCode, 200);
  assert.equal(JSON.parse(state.body).ok, true);
  const last = seen[seen.length - 1];
  assert.equal(last.url, "/api/state");
  assert.equal(last.auth, `Bearer ${TOKEN}`);

  const out = await auth(ev("/auth/logout", { httpMethod: "POST", headers }));
  assert.match(out.headers["set-cookie"], /Max-Age=0/);
});

test("forwarded POST body and file download headers pass through", async () => {
  const login = await auth(ev("/auth/login", { httpMethod: "POST", body: JSON.stringify({ password: PASSWORD }) }));
  const headers = { cookie: cookieFrom(login) };

  const post = await api(ev("/api/start", { httpMethod: "POST", headers, body: JSON.stringify({ domains: "x.com", dryRun: true }) }));
  assert.equal(post.statusCode, 200);
  assert.equal(seen[seen.length - 1].body, JSON.stringify({ domains: "x.com", dryRun: true }));

  const file = await api(ev("/api/files/emails.txt", { headers }));
  assert.equal(file.statusCode, 200);
  assert.equal(file.headers["content-disposition"], 'attachment; filename="emails.txt"');
});

test("routes outside the allow list are refused", async () => {
  const login = await auth(ev("/auth/login", { httpMethod: "POST", body: JSON.stringify({ password: PASSWORD }) }));
  const headers = { cookie: cookieFrom(login) };
  const before = seen.length;
  assert.equal((await api(ev("/api/admin", { headers }))).statusCode, 404);
  assert.equal((await api(ev("/api/files/../state", { headers }))).statusCode, 404);
  assert.equal(seen.length, before);
});
