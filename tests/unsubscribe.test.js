// One-click unsubscribe tests: signed links, the public /unsubscribe route, and the PUBLIC_BASE_URL requirement.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { createStore } from "../server/store.js";
import { CampaignRunner } from "../server/campaign.js";
import { createApp } from "../server/app.js";
import { makeUnsubscribeToken, readUnsubscribeToken, unsubscribeUrl } from "../server/unsubscribe.js";

const SECRET = "unsub-test-secret-0123456789abcdef";
const TOKEN = "unsub-test-token-0123456789abcdefgh";

async function newStore() {
  const store = createStore(mkdtempSync(path.join(os.tmpdir(), "fh-unsub-")));
  await store.load();
  store.set({
    profile: { ...store.get().profile, address: "1 Main Street", city: "Dublin" },
    campaign: { subject: "Hello", body: "We would like to talk." },
  });
  await store.flush();
  return store;
}

async function serve(store, { publicBaseUrl = "https://site.example" } = {}) {
  const sent = [];
  const mailer = { from: "outreach@example.com", send: async (m) => { sent.push(m); } };
  const campaigns = new CampaignRunner(store, { mailer: () => mailer, publicBaseUrl, unsubscribeSecret: SECRET, sleep: async () => {} });
  const app = createApp({ store, engine: { running: false, stop() {} }, token: TOKEN, origins: [], campaigns });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, { method = "GET", body } = {}) =>
    fetch(base + route, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { base, call, sent, campaigns, close: () => server.close() };
}

test("a signed token reads back to its address, and a changed or foreign token is refused", () => {
  const token = makeUnsubscribeToken("Jane@Company.com", SECRET);
  assert.equal(readUnsubscribeToken(token, SECRET), "jane@company.com");
  assert.equal(readUnsubscribeToken(token, "a-different-secret-that-is-long-enough"), null);
  const [id, sig] = token.split(".");
  const other = makeUnsubscribeToken("bob@other.org", SECRET).split(".")[0];
  assert.equal(readUnsubscribeToken(`${other}.${sig}`, SECRET), null); // swapped address
  assert.equal(readUnsubscribeToken(`${id}.${sig}.extra`, SECRET), null);
  assert.equal(readUnsubscribeToken("", SECRET), null);
  assert.equal(readUnsubscribeToken(undefined, SECRET), null);
});

test("the link is built from the site address", () => {
  const url = unsubscribeUrl("https://site.example/", "jane@company.com", SECRET);
  assert.match(url, /^https:\/\/site\.example\/unsubscribe\?t=/);
  assert.equal(readUnsubscribeToken(new URL(url).searchParams.get("t"), SECRET), "jane@company.com");
});

test("visiting a valid link unsubscribes the address, and it is then never emailed", async () => {
  const store = await newStore();
  store.set({ contacts: [{ email: "jane@company.com", consentSource: "signup", consentDate: "2026-01-15" }] });
  const srv = await serve(store);
  try {
    const token = makeUnsubscribeToken("jane@company.com", TOKEN);
    const r = await fetch(`${srv.base}/unsubscribe?t=${token}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/html/);
    assert.match(await r.text(), /You have been unsubscribed/);
    assert.deepEqual(store.get().suppressed, ["jane@company.com"]);

    // A second click does nothing extra.
    await fetch(`${srv.base}/unsubscribe?t=${token}`, { method: "POST" });
    assert.deepEqual(store.get().suppressed, ["jane@company.com"]);

    srv.campaigns.start({ dryRun: false });
    await srv.campaigns.current;
    assert.equal(srv.sent.length, 0);
  } finally {
    srv.close();
  }
});

test("a forged or missing token is refused and changes nothing", async () => {
  const store = await newStore();
  const srv = await serve(store);
  try {
    const r = await fetch(`${srv.base}/unsubscribe?t=bogus.token`);
    assert.equal(r.status, 400);
    const r2 = await fetch(`${srv.base}/unsubscribe`);
    assert.equal(r2.status, 400);
    assert.deepEqual(store.get().suppressed, []);
  } finally {
    srv.close();
  }
});

test("the unsubscribe route needs no sign-in", async () => {
  const store = await newStore();
  const srv = await serve(store);
  try {
    const token = makeUnsubscribeToken("x@y.com", TOKEN);
    const r = await fetch(`${srv.base}/unsubscribe?t=${token}`); // no Authorization header
    assert.equal(r.status, 200);
  } finally {
    srv.close();
  }
});

test("a live campaign is refused until PUBLIC_BASE_URL is set", async () => {
  const store = await newStore();
  const srv = await serve(store, { publicBaseUrl: "" });
  try {
    const r = await srv.call("/api/campaign/start", { method: "POST", body: { dryRun: true } });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /PUBLIC_BASE_URL/);
  } finally {
    srv.close();
  }
});
