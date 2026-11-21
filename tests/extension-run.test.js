// Runs the real extension service worker (extension/background.js) against a simulated Chrome.
// The fake browser behaves like Chrome where it matters here: a removed tab rejects anything
// still waiting on it, and history deletions are recorded. Tests check that nothing hangs.
import { test } from "node:test";
import assert from "node:assert/strict";

// Short limits, so the tests run in seconds. Read once when the service worker loads.
globalThis.__FILLHERO_TEST__ = { stepMs: 300, submitMs: 300, translateMs: 300, domainMs: 1000, historyEvery: 2 };

const storage = {};
const tabs = new Map(); // id -> { url, hang }
const pending = new Map(); // tabId -> reject functions for calls that will never answer
const removed = [];
const historyDeleted = [];
const listeners = { updated: new Set(), removed: new Set(), message: null };
let nextId = 1;
let hangNewTabs = false; // when true, the page never answers script or message calls
let hangTabsGet = false; // when true, the browser's own tab lookup never answers

function never(tabId) {
  return new Promise((_, reject) => {
    if (!pending.has(tabId)) pending.set(tabId, []);
    pending.get(tabId).push(reject);
  });
}

function scanReply(msg) {
  if (msg.type === "scan") return { forms: [], captcha: false, url: "", lang: "en" };
  if (msg.type === "fill") return { ok: true, missing: [], unverified: [], reapplied: 0 };
  return { ok: true, outcome: "confirmed" };
}

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const out = {};
        for (const k of Array.isArray(keys) ? keys : Object.keys(keys ?? {})) if (k in storage) out[k] = structuredClone(storage[k]);
        return out;
      },
      async set(obj) {
        Object.assign(storage, structuredClone(obj));
      },
    },
  },
  tabs: {
    async create({ url }) {
      const id = nextId++;
      tabs.set(id, { url, hang: hangNewTabs });
      return { id, url };
    },
    async get(id) {
      if (hangTabsGet) return new Promise(() => {});
      const t = tabs.get(id);
      if (!t) throw new Error(`No tab with id: ${id}`);
      return { id, url: t.url };
    },
    async update(id, { url }) {
      const t = tabs.get(id);
      if (!t) throw new Error(`No tab with id: ${id}`);
      t.url = url;
      setTimeout(() => listeners.updated.forEach((fn) => fn(id, { status: "complete" })), 5);
      return {};
    },
    async remove(id) {
      if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`);
      tabs.delete(id);
      removed.push(id);
      for (const reject of pending.get(id) ?? []) reject(new Error(`No tab with id: ${id}`));
      pending.delete(id);
    },
    async sendMessage(id, msg) {
      const t = tabs.get(id);
      if (!t) throw new Error(`No tab with id: ${id}`);
      if (t.hang) return never(id);
      return scanReply(msg);
    },
    onUpdated: { addListener: (fn) => listeners.updated.add(fn), removeListener: (fn) => listeners.updated.delete(fn) },
    onRemoved: { addListener: (fn) => listeners.removed.add(fn) },
  },
  scripting: {
    async executeScript({ target: { tabId }, func }) {
      const t = tabs.get(tabId);
      if (!t) throw new Error(`No tab with id: ${tabId}`);
      if (t.hang) return never(tabId);
      return [{ result: func ? [] : undefined }];
    },
  },
  runtime: {
    onMessage: { addListener: (fn) => (listeners.message = fn) },
    sendMessage: undefined,
  },
  downloads: { async download() { return {}; } },
  history: {
    async deleteUrl({ url }) {
      historyDeleted.push(url);
    },
  },
};

// The service worker registers its message handler when it loads.
await import("../extension/background.js");

function ask(msg) {
  return new Promise((resolve) => listeners.message(msg, {}, resolve));
}

async function waitForIdle(limitMs = 8000) {
  const start = Date.now();
  for (;;) {
    const s = await ask({ type: "state" });
    if (!s.running) return Date.now() - start;
    if (Date.now() - start > limitMs) throw new Error("the run did not finish: it is hung");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function resetWorld() {
  for (const k of Object.keys(storage)) delete storage[k];
  tabs.clear();
  pending.clear();
  removed.length = 0;
  historyDeleted.length = 0;
  hangNewTabs = false;
  hangTabsGet = false;
}

async function startRun(domains, { dryRun = true } = {}) {
  await ask({ type: "start", domains, dryRun, profile: { firstName: "Pat", lastName: "Tester", company: "Acme", email: "pat@example.com", template: "Hello {domain}" } });
}

test("a page that never answers is given up on, and the run still finishes", async () => {
  resetWorld();
  hangNewTabs = true;
  const elapsed0 = Date.now();
  await startRun("alpha-site.com");
  await waitForIdle();
  assert.ok(Date.now() - elapsed0 < 5000, `took ${Date.now() - elapsed0} ms`);
  const log = storage.log ?? [];
  const row = log.find((e) => e.host === "alpha-site.com");
  assert.ok(row, JSON.stringify(log));
  // Either every step gave up and the domain was queued, or the whole-domain limit ended it. Both are fine.
  assert.match(row.reason, /no-usable-form|timed out/);
  assert.equal(log.some((e) => e.status === "sent" || e.status === "sent?"), false, "nothing may be counted as sent");
});

test("a browser call that never returns is cut off by the whole-domain limit", async () => {
  resetWorld();
  hangTabsGet = true;
  await startRun("beta-site.com", { dryRun: false });
  await waitForIdle();
  const row = (storage.log ?? []).find((e) => e.host === "beta-site.com");
  assert.ok(row, JSON.stringify(storage.log));
  assert.equal(row.status, "failed");
  assert.match(row.reason, /timed out after/);
  assert.ok(removed.length >= 1, "the stuck tab was closed");
});

test("Stop closes the open tab and the run ends at once", async () => {
  resetWorld();
  hangNewTabs = true;
  await startRun("gamma-site.com", { dryRun: false });
  await new Promise((r) => setTimeout(r, 100));
  const stopAt = Date.now();
  await ask({ type: "stop" });
  await waitForIdle(3000);
  assert.ok(Date.now() - stopAt < 3000, `stop took ${Date.now() - stopAt} ms`);
  assert.ok(removed.length >= 1, "the open tab was closed by Stop");
});

test("the history watchdog removes the pages it visited after every batch of visits", async () => {
  resetWorld();
  await startRun("delta-site.com\nepsilon-site.com", { dryRun: true });
  await waitForIdle();
  const log = storage.log ?? [];
  const cleared = log.find((e) => e.status === "history-cleared");
  assert.ok(cleared, JSON.stringify(log.map((e) => e.status)));
  assert.ok(historyDeleted.some((u) => u.includes("delta-site.com")), JSON.stringify(historyDeleted));
  assert.ok(historyDeleted.some((u) => u.includes("epsilon-site.com")), JSON.stringify(historyDeleted));
  assert.equal(storage.visitCount, 0);
  assert.deepEqual(storage.visitedUrls, []);
});
