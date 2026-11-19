// End-to-end tests for the server: the API, token checks, and a real headless run against a
// local copy of the test site. Nothing leaves this computer.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../server/store.js";
import { Engine } from "../server/engine.js";
import { createApp } from "../server/app.js";

const TOKEN = "test-token-that-is-long-enough-1234";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "..", "fill_hero_py", "fixture");

const requests = [];
let siteServer;
let sitePort;

function startSite() {
  return new Promise((resolve) => {
    siteServer = http.createServer(async (req, res) => {
      requests.push(req.url);
      const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
      const file = path.join(FIXTURE, rel);
      if (!file.startsWith(FIXTURE)) return res.writeHead(403).end();
      try {
        const body = await fs.readFile(file);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    siteServer.listen(0, "127.0.0.1", () => {
      sitePort = siteServer.address().port;
      resolve();
    });
  });
}

// Builds a fresh store, engine and API server for one test.
async function makeApi() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fillhero-"));
  const store = createStore(dir);
  await store.load();
  store.set({
    profile: {
      firstName: "Pat", lastName: "Tester", company: "Acme", email: "pat@example.com",
      subject: "Quote request", template: "Hello {domain} team, from {company}.",
    },
  });
  const engine = new Engine(store, { launchOptions: { args: ["--no-sandbox"] } });
  const app = createApp({ store, engine, token: TOKEN, origins: ["https://example.netlify.app"] });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, engine, server, base, dir };
}

async function api(base, method, route, body, token = TOKEN) {
  const res = await fetch(base + route, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.text() };
}

async function cleanup(ctx) {
  await new Promise((r) => ctx.server.close(r));
  await fs.rm(ctx.dir, { recursive: true, force: true });
}

before(startSite);
after(() => new Promise((r) => siteServer.close(r)));

test("health is open, everything else needs the token", async () => {
  const ctx = await makeApi();
  try {
    assert.equal((await api(ctx.base, "GET", "/api/health", null, "")).status, 200);
    assert.equal((await api(ctx.base, "GET", "/api/state", null, "")).status, 401);
    assert.equal((await api(ctx.base, "GET", "/api/state", null, "wrong-token-wrong-token-1234")).status, 401);
    assert.equal((await api(ctx.base, "GET", "/api/state")).status, 200);
  } finally {
    await cleanup(ctx);
  }
});

test("CORS allows only the listed front-end origin", async () => {
  const ctx = await makeApi();
  try {
    const ok = await fetch(ctx.base + "/api/health", { headers: { origin: "https://example.netlify.app" } });
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://example.netlify.app");
    const other = await fetch(ctx.base + "/api/health", { headers: { origin: "https://evil.example" } });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
  } finally {
    await cleanup(ctx);
  }
});

test("profile is validated and saved", async () => {
  const ctx = await makeApi();
  try {
    assert.equal((await api(ctx.base, "PUT", "/api/profile", { city: 5 })).status, 400);
    assert.equal((await api(ctx.base, "PUT", "/api/profile", { city: "Berlin", zip: "10115" })).status, 200);
    const state = JSON.parse((await api(ctx.base, "GET", "/api/state")).body);
    assert.equal(state.profile.city, "Berlin");
    assert.equal(state.profile.zip, "10115");
    assert.match(state.profile.template, /Hello \{domain\} team/); // defaults kept
  } finally {
    await cleanup(ctx);
  }
});

test("a live run fills and submits the fixture form, and the site receives the values", async () => {
  const ctx = await makeApi();
  requests.length = 0;
  try {
    const start = await api(ctx.base, "POST", "/api/start", { domains: `http://127.0.0.1:${sitePort}/`, dryRun: false });
    assert.equal(start.status, 202, start.body);
    await ctx.engine.current;

    const rows = ctx.store.get().log;
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0].status, "sent", JSON.stringify(rows[0]));
    assert.match(rows[0].reason, /filled=firstName,lastName,company,email,subject,message/);

    // The live view recorded each step, and kept a screenshot of the form.
    const live = ctx.engine.live.snapshot();
    const texts = live.steps.map((s) => s.text).join(" | ");
    assert.match(texts, /Run started/);
    assert.match(texts, /Opened/);
    assert.match(texts, /Filled the form/);
    assert.match(texts, /Submitted/);
    assert.ok(live.image && live.image.length > 1000, "a screenshot was kept in the live view");

    const submitted = requests.find((u) => u.startsWith("/thanks.html?"));
    assert.ok(submitted, JSON.stringify(requests));
    const params = new URL(submitted, "http://x").searchParams;
    assert.equal(params.get("first-name"), "Pat");
    assert.equal(params.get("last-name"), "Tester");
    assert.equal(params.get("company"), "Acme");
    assert.equal(params.get("email"), "pat@example.com");
    assert.equal(params.get("subject"), "Quote request");
    assert.match(params.get("message"), new RegExp(`^Hello 127\\.0\\.0\\.1:${sitePort} team`));

    // A sent domain is never contacted again, even after Clear all.
    await api(ctx.base, "POST", "/api/clear");
    const before2 = requests.length;
    await api(ctx.base, "POST", "/api/start", { domains: `http://127.0.0.1:${sitePort}/`, dryRun: false });
    await ctx.engine.current;
    assert.equal(ctx.store.get().log[0].status, "skipped");
    assert.equal(ctx.store.get().log[0].reason, "already-sent");
    assert.equal(requests.slice(before2).some((u) => u.startsWith("/thanks.html?")), false);
  } finally {
    await cleanup(ctx);
  }
});

test("a dry run fills but never submits", async () => {
  const ctx = await makeApi();
  requests.length = 0;
  try {
    await api(ctx.base, "POST", "/api/start", { domains: `http://127.0.0.1:${sitePort}/`, dryRun: true });
    await ctx.engine.current;
    const row = ctx.store.get().log[0];
    assert.equal(row.status, "skipped");
    assert.match(row.reason, /^dry-run/);
    assert.equal(requests.some((u) => u.startsWith("/thanks.html")), false);
  } finally {
    await cleanup(ctx);
  }
});

test("a run is refused while another is running, and start needs at least one domain", async () => {
  const ctx = await makeApi();
  try {
    assert.equal((await api(ctx.base, "POST", "/api/start", { domains: "   ", dryRun: true })).status, 400);
    await api(ctx.base, "POST", "/api/start", { domains: `http://127.0.0.1:${sitePort}/`, dryRun: true });
    const second = await api(ctx.base, "POST", "/api/start", { domains: `http://127.0.0.1:${sitePort}/`, dryRun: true });
    assert.equal(second.status, 409);
    await ctx.engine.current;
  } finally {
    await cleanup(ctx);
  }
});

test("the emails file is served as an attachment", async () => {
  const ctx = await makeApi();
  try {
    ctx.store.set({ emails: [{ host: "a.com", email: "info@a.com", pageUrl: "", at: 0 }] });
    const res = await fetch(ctx.base + "/api/files/emails.txt", { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition"), /extractedemails\.txt/);
    assert.match(await res.text(), /info@a\.com\ta\.com/);
  } finally {
    await cleanup(ctx);
  }
});
