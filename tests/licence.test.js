// Licence tests: key format, hashed storage, the server's verify and admin routes, the attempt limit,
// and the extension's decision rules (src/lib/licence.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { createStore } from "../server/store.js";
import { CampaignRunner } from "../server/campaign.js";
import { createApp } from "../server/app.js";
import { generateKey, issueLicence, revokeLicence, findLicence, hashKey, makeAttemptLimiter } from "../server/licence.js";
import { needsCheck, decide, CHECK_EVERY_MS, GRACE_MS } from "../src/lib/licence.js";

const TOKEN = "licence-test-token-0123456789abcdefgh";
const DAY = 24 * 60 * 60 * 1000;

async function newStore() {
  const store = createStore(mkdtempSync(path.join(os.tmpdir(), "fh-licence-")));
  await store.load();
  return store;
}

async function serve(store) {
  const campaigns = new CampaignRunner(store, { mailer: () => null, sleep: async () => {} });
  const app = createApp({ store, engine: { running: false, stop() {} }, token: TOKEN, origins: [], campaigns });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, { method = "GET", body, token = TOKEN } = {}) =>
    fetch(base + route, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { base, call, close: () => server.close() };
}

test("keys have the FH-XXXXX-XXXXX-XXXXX-XXXXX shape and no confusable characters", () => {
  for (let i = 0; i < 50; i++) {
    const key = generateKey();
    assert.match(key, /^FH-[2-9A-HJ-KM-NP-Z]{5}-[2-9A-HJ-KM-NP-Z]{5}-[2-9A-HJ-KM-NP-Z]{5}-[2-9A-HJ-KM-NP-Z]{5}$/);
  }
});

test("a key is stored only as a hash, and matches regardless of case or spaces", () => {
  const { key, licences } = issueLicence([], "Acme");
  const stored = JSON.stringify(licences);
  assert.ok(!stored.includes(key), "the plain key must not be stored");
  assert.ok(findLicence(licences, key));
  assert.ok(findLicence(licences, `  ${key.toLowerCase()} `));
  assert.equal(findLicence(licences, "FH-NOPE0-NOPE0-NOPE0-NOPE0"), null);
  assert.equal(hashKey(key), hashKey(key.toLowerCase()));
});

test("issuing returns the key once; the list never shows keys or hashes", async () => {
  const store = await newStore();
  const srv = await serve(store);
  try {
    const r = await srv.call("/api/licences", { method: "POST", body: { customer: "Acme Ltd" } });
    assert.equal(r.status, 201);
    const issued = await r.json();
    assert.match(issued.key, /^FH-/);
    const list = await (await srv.call("/api/licences")).json();
    assert.equal(list.licences.length, 1);
    assert.equal(list.licences[0].customer, "Acme Ltd");
    assert.equal(list.licences[0].keyHash, undefined);
    assert.ok(!JSON.stringify(list).includes(issued.key));
  } finally {
    srv.close();
  }
});

test("verify says valid for an active key and not valid after revocation", async () => {
  const store = await newStore();
  const srv = await serve(store);
  try {
    const issued = await (await srv.call("/api/licences", { method: "POST", body: { customer: "Acme" } })).json();
    let v = await (await srv.call("/licence/verify", { method: "POST", body: { key: issued.key }, token: "" })).json();
    assert.equal(v.valid, true); assert.equal(v.customer, "Acme");

    const rv = await srv.call(`/api/licences/${issued.id}/revoke`, { method: "POST" });
    assert.equal(rv.status, 200);
    v = await (await srv.call("/licence/verify", { method: "POST", body: { key: issued.key }, token: "" })).json();
    assert.deepEqual(v, { valid: false, reason: "not-valid" });
  } finally {
    srv.close();
  }
});

test("verify needs no token, but admin routes do", async () => {
  const store = await newStore();
  const srv = await serve(store);
  try {
    const noToken = await srv.call("/api/licences", { token: "" });
    assert.equal(noToken.status, 401);
    const issueNoToken = await srv.call("/api/licences", { method: "POST", body: { customer: "x" }, token: "" });
    assert.equal(issueNoToken.status, 401);
    assert.equal(store.get().licences.length, 0);
    const verify = await srv.call("/licence/verify", { method: "POST", body: { key: "FH-X" }, token: "" });
    assert.equal(verify.status, 200);
  } finally {
    srv.close();
  }
});

test("with APPROVED_BUILDS set, only an approved build gets a valid answer", async () => {
  const store = await newStore();
  const campaigns = new CampaignRunner(store, { mailer: () => null, sleep: async () => {} });
  const app = createApp({ store, engine: { running: false, stop() {} }, token: TOKEN, origins: [], campaigns, approvedBuilds: ["APPROVED1"] });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const verify = (body) =>
    fetch(`${base}/licence/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  try {
    const issued = issueLicence([], "Acme");
    store.set({ licences: issued.licences });

    const ok = await verify({ key: issued.key, build: "APPROVED1" }); assert.equal(ok.valid, true); assert.equal(ok.customer, "Acme");
    assert.equal((await verify({ key: issued.key, build: "EDITED-COPY" })).valid, false);
    assert.equal((await verify({ key: issued.key })).valid, false, "no build sent is refused when builds are approved");
  } finally {
    server.close();
  }
});

test("revoking an unknown or already-revoked licence is refused", async () => {
  const store = await newStore();
  const srv = await serve(store);
  try {
    const issued = await (await srv.call("/api/licences", { method: "POST", body: { customer: "Acme" } })).json();
    assert.equal((await srv.call("/api/licences/ffffff/revoke", { method: "POST" })).status, 404);
    assert.equal((await srv.call(`/api/licences/${issued.id}/revoke`, { method: "POST" })).status, 200);
    assert.equal((await srv.call(`/api/licences/${issued.id}/revoke`, { method: "POST" })).status, 404);
  } finally {
    srv.close();
  }
});

test("a customer name is required", async () => {
  const store = await newStore();
  const srv = await serve(store);
  try {
    assert.equal((await srv.call("/api/licences", { method: "POST", body: { customer: "   " } })).status, 400);
  } finally {
    srv.close();
  }
});

test("failed guesses are limited per address", () => {
  const limiter = makeAttemptLimiter({ max: 3, windowMs: 1000 });
  const t = 1000;
  for (let i = 0; i < 3; i++) limiter.failed("1.2.3.4", t);
  assert.equal(limiter.blocked("1.2.3.4", t), true);
  assert.equal(limiter.blocked("5.6.7.8", t), false);
  assert.equal(limiter.blocked("1.2.3.4", t + 2000), false, "the window resets");
});

// ---------- the extension's decision rules ----------

test("the extension checks the server at most once a day", () => {
  const now = 10 * DAY;
  assert.equal(needsCheck(null, now), true);
  assert.equal(needsCheck({ key: "K", checkedAt: now - 1000, valid: true }, now), false);
  assert.equal(needsCheck({ key: "K", checkedAt: now - CHECK_EVERY_MS, valid: true }, now), true);
  assert.equal(needsCheck({ key: "K", checkedAt: now, valid: false }, now), true);
});

test("a valid server answer allows the run and saves the check", () => {
  const d = decide(null, "K", 5, { valid: true, customer: "Acme" });
  assert.equal(d.allowed, true);
  assert.deepEqual(d.cache, { key: "K", checkedAt: 5, valid: true, customer: "Acme", expiresAt: null });
});

test("an invalid answer refuses the run even if an older check was valid", () => {
  const cache = { key: "K", checkedAt: 1, valid: true, customer: "Acme" };
  const d = decide(cache, "K", 5, { valid: false });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "licence-not-valid");
});

test("with no server answer, a recent valid key works and an old one does not", () => {
  const now = 10 * DAY;
  const recent = { key: "K", checkedAt: now - GRACE_MS + 1000, valid: true, customer: "Acme" };
  assert.equal(decide(recent, "K", now, null).allowed, true);
  const old = { key: "K", checkedAt: now - GRACE_MS - 1000, valid: true, customer: "Acme" };
  assert.equal(decide(old, "K", now, null).allowed, false);
});

test("a key with a duration is stored with its expiry date; 0 means no expiry", () => {
  const now = 1000;
  const timed = issueLicence([], "Acme", 30, now).licence;
  assert.equal(timed.expiresAt, now + 30 * DAY);
  const forever = issueLicence([], "Acme", 0, now).licence;
  assert.equal(forever.expiresAt, null);
});

test("the server refuses an expired key, and a key still in its term is valid", async () => {
  const store = await newStore();
  const past = issueLicence([], "Old", 1, Date.now() - 2 * DAY);
  store.set({ licences: past.licences });
  const current = issueLicence(past.licences, "New", 30);
  store.set({ licences: current.licences });
  const srv = await serve(store);
  try {
    const expired = await (await srv.call("/licence/verify", { method: "POST", body: { key: past.key }, token: "" })).json();
    assert.equal(expired.valid, false);
    assert.equal(expired.reason, "expired");
    const live = await (await srv.call("/licence/verify", { method: "POST", body: { key: current.key }, token: "" })).json();
    assert.equal(live.valid, true);
    assert.equal(typeof live.expiresAt, "number");
  } finally {
    srv.close();
  }
});

test("issuing rejects a duration that is not a whole number of days in range", async () => {
  const store = await newStore();
  const srv = await serve(store);
  try {
    for (const days of [-1, 1.5, 4000, "30"]) {
      const r = await srv.call("/api/licences", { method: "POST", body: { customer: "Acme", days } });
      assert.equal(r.status, 400, `days=${days}`);
    }
    assert.equal(store.get().licences.length, 0);
  } finally {
    srv.close();
  }
});

test("an expired key is never valid, even inside the offline grace period", () => {
  const now = 10 * DAY;
  const cache = { key: "K", checkedAt: now - 1000, valid: true, customer: "Acme", expiresAt: now - 1 };
  assert.equal(decide(cache, "K", now, null).allowed, false);
  assert.equal(needsCheck(cache, now), true);
});

test("no key means no run, whatever the server says", () => {
  assert.equal(decide(null, "", 1, { valid: true }).allowed, false);
});
