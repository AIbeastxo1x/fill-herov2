// Runs the real extension service worker (extension/background.js) against a simulated Chrome.
// The fake browser behaves like Chrome where it matters here: a removed tab rejects anything
// still waiting on it, and history deletions are recorded. Tests check that nothing hangs.
import { test } from "node:test";
import assert from "node:assert/strict";

// Short limits, so the tests run in seconds. Read once when the service worker loads.
// domainMs is long enough for a normal domain (which includes retry pauses) and short enough to test the limit.
globalThis.__FILLHERO_TEST__ = { stepMs: 300, submitMs: 300, translateMs: 300, domainMs: 4000, historyEvery: 2, licenceUrl: "https://licence.test/verify" };

const TEST_KEY = "FH-TEST1-TEST2-TEST3-TEST4";
const OTHER_KEY = "FH-OTHE1-OTHE2-OTHE3-OTHE4";
// What the fake licence server says. mode: "valid" | "invalid" | "down".
const licenceServer = { mode: "valid", calls: 0 };
globalThis.fetch = async (url, opts) => {
  if (url !== "https://licence.test/verify") throw new Error(`unexpected request to ${url}`);
  licenceServer.calls += 1;
  if (licenceServer.mode === "down") throw new Error("network down");
  const { key } = JSON.parse(opts.body);
  const valid = licenceServer.mode === "valid" && key === TEST_KEY;
  return { ok: true, status: 200, json: async () => ({ valid, customer: valid ? "Test Customer" : undefined }) };
};

const storage = {};
const tabs = new Map(); // id -> { url, hang }
const pending = new Map(); // tabId -> reject functions for calls that will never answer
const removed = [];
const historyDeleted = [];
const notified = []; // desktop notifications shown by the extension
const listeners = { updated: new Set(), removed: new Set(), message: null };
let nextId = 1;
let hangNewTabs = false; // when true, the page never answers script or message calls
let hangTabsGet = false; // when true, the browser's own tab lookup never answers
let slowMs = 0; // when above 0, each page call takes this long, to see domains working side by side
let peakOpen = 0; // the most tabs open at the same moment

function never(tabId) {
  return new Promise((_, reject) => {
    if (!pending.has(tabId)) pending.set(tabId, []);
    pending.get(tabId).push(reject);
  });
}

// A contact form with a name, an email and a message box: the kind the extension submits by itself.
const CONTACT_FORM = {
  index: 0,
  hasPassword: false,
  action: "/send",
  id: "",
  className: "",
  fields: [
    { tag: "input", type: "text", name: "name", id: "", placeholder: "", autocomplete: "", label: "Name", required: false },
    { tag: "input", type: "email", name: "email", id: "", placeholder: "", autocomplete: "", label: "Email", required: false },
    { tag: "textarea", type: "textarea", name: "message", id: "", placeholder: "", autocomplete: "", label: "Message", required: false },
  ],
};
let pageSource = ""; // the HTML the page read returns, for testing email extraction
let tabsGetCalls = 0; // how many times the browser's tab lookup has been asked
let hangTabsGetAfter = Infinity; // tab lookups after this many never answer, to run a domain out of time part-way
let formOffered = false; // when true, every page the run visits has the contact form
let submitVerdict = { outcome: "confirmed", reason: "confirmation text shown" }; // what the page says after a submit

function scanReply(msg) {
  if (msg.type === "scan") return { forms: formOffered ? [CONTACT_FORM] : [], captcha: false, url: "", lang: "en" };
  if (msg.type === "fill") return { ok: true, missing: [], unverified: [], reapplied: 0 };
  if (msg.type === "submit") return submitVerdict;
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
      peakOpen = Math.max(peakOpen, tabs.size);
      return { id, url };
    },
    async get(id) {
      tabsGetCalls++;
      if (hangTabsGet || tabsGetCalls > hangTabsGetAfter) return new Promise(() => {});
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
      if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
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
      if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
      const t = tabs.get(tabId);
      if (!t) throw new Error(`No tab with id: ${tabId}`);
      if (t.hang) return never(tabId);
      // The page source read (outerHTML) returns the test page's text; other page calls return nothing.
      if (func) return [{ result: func.toString().includes("outerHTML") ? pageSource : [] }];
      return [{ result: undefined }];
    },
  },
  downloads: { async download() { return {}; } },
  notifications: {
    async create(options) {
      notified.push(options);
      return "fh";
    },
  },
  runtime: {
    onMessage: { addListener: (fn) => (listeners.message = fn) },
    getURL: (file) => `chrome-extension://test/${file}`,
  },
  history: {
    async deleteUrl({ url }) {
      historyDeleted.push(url);
    },
  },
};

// The service worker registers its message handler when it loads.
// FH_EXTENSION_BUILD=dist runs the same scenarios against the protected build.
const BUILD = process.env.FH_EXTENSION_BUILD === "dist" ? "../dist/extension/background.js" : "../extension/background.js";
await import(BUILD);

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

// Every test starts with a valid licence that was checked moments ago, so runs do not depend on the server.
function resetWorld() {
  for (const k of Object.keys(storage)) delete storage[k];
  tabs.clear();
  pending.clear();
  removed.length = 0;
  historyDeleted.length = 0;
  notified.length = 0;
  hangNewTabs = false;
  hangTabsGet = false;
  slowMs = 0;
  peakOpen = 0;
  formOffered = false;
  pageSource = "";
  tabsGetCalls = 0;
  hangTabsGetAfter = Infinity;
  submitVerdict = { outcome: "confirmed", reason: "confirmation text shown" };
  licenceServer.mode = "valid";
  licenceServer.calls = 0;
  storage.licenceKey = TEST_KEY;
  storage.licenceCache = { key: TEST_KEY, checkedAt: Date.now(), valid: true, customer: "Test Customer" };
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

test("without a licence, a run does not start and no page is opened", async () => {
  resetWorld();
  delete storage.licenceKey;
  delete storage.licenceCache;
  const res = await ask({ type: "start", domains: "zeta-site.com", dryRun: true, profile: {} });
  assert.deepEqual(res, { ok: false, reason: "no-licence" });
  assert.equal(tabs.size, 0);
  assert.equal(licenceServer.calls, 0);
});

test("a key the server rejects does not start a run", async () => {
  resetWorld();
  storage.licenceKey = OTHER_KEY;
  storage.licenceCache = null;
  licenceServer.mode = "valid"; // the server only accepts TEST_KEY, so OTHER_KEY is refused
  const res = await ask({ type: "start", domains: "eta-site.com", dryRun: true, profile: {} });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "licence-not-valid");
  assert.equal(tabs.size, 0);
});

test("a valid key is checked once, then trusted for a day without asking again", async () => {
  resetWorld();
  storage.licenceCache = null;
  const first = await ask({ type: "setLicence", key: TEST_KEY });
  assert.equal(first.allowed, true);
  const callsAfterFirst = licenceServer.calls;
  const status = await ask({ type: "licenceStatus" });
  assert.equal(status.valid, true);
  assert.equal(status.customer, "Test Customer");
  const again = await ask({ type: "start", domains: "theta-site.com", dryRun: true, profile: {} });
  assert.equal(again.ok, true);
  assert.equal(licenceServer.calls, callsAfterFirst, "no second server call inside the day");
  await waitForIdle();
});

test("if the server cannot be reached, a key checked within 72 hours still works", async () => {
  resetWorld();
  storage.licenceCache = { key: TEST_KEY, checkedAt: Date.now() - 2 * 24 * 60 * 60 * 1000, valid: true, customer: "Test Customer" };
  licenceServer.mode = "down";
  const res = await ask({ type: "start", domains: "iota-site.com", dryRun: true, profile: {} });
  assert.equal(res.ok, true, JSON.stringify(res));
  await waitForIdle();
});

test("if the server cannot be reached and the last check is too old, the run is refused", async () => {
  resetWorld();
  storage.licenceCache = { key: TEST_KEY, checkedAt: Date.now() - 4 * 24 * 60 * 60 * 1000, valid: true, customer: "Test Customer" };
  licenceServer.mode = "down";
  const res = await ask({ type: "start", domains: "kappa-site.com", dryRun: true, profile: {} });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "cannot-check-licence");
});

test("a finished run closes every tab it opened and shows one notification with the results", async () => {
  resetWorld();
  await startRun("lambda-site.com\nmu-site.com", { dryRun: true });
  await waitForIdle();
  assert.equal(tabs.size, 0, `tabs still open: ${[...tabs.keys()].join(", ")}`);
  assert.equal(notified.length, 1, JSON.stringify(notified));
  assert.equal(notified[0].title, "Fill Hero: run finished");
  assert.match(notified[0].message, /2 queued for review/, JSON.stringify(storage.log));
});

test("Stop also closes the tabs and shows a 'run stopped' notification", async () => {
  resetWorld();
  hangNewTabs = true;
  await startRun("nu-site.com", { dryRun: false });
  await new Promise((r) => setTimeout(r, 100));
  await ask({ type: "stop" });
  await waitForIdle(3000);
  assert.equal(tabs.size, 0, `tabs still open: ${[...tabs.keys()].join(", ")}`);
  assert.equal(notified.length, 1);
  assert.equal(notified[0].title, "Fill Hero: run stopped");
});

test("a site with no usable form has its email addresses saved for the export", async () => {
  resetWorld();
  pageSource = `<p>Write to info@nofrm-site.com</p>`;
  await startRun("nofrm-site.com");
  await waitForIdle();
  const saved = (storage.emails ?? []).filter((e) => e.host === "nofrm-site.com").map((e) => e.email);
  assert.deepEqual(saved, ["info@nofrm-site.com"], JSON.stringify(storage.emails));
});

test("addresses read before a domain runs out of time are still saved", async () => {
  resetWorld();
  pageSource = `<p>Write to timeout-site@example.org</p>`;
  hangTabsGetAfter = 2; // the domain stalls on its next page, after its home page has been read
  await startRun("slow-emails.com");
  await waitForIdle(12000);
  const row = (storage.log ?? []).find((e) => e.host === "slow-emails.com");
  assert.match(row?.reason ?? "", /timed out/, JSON.stringify(storage.log));
  const saved = (storage.emails ?? []).filter((e) => e.host === "slow-emails.com").map((e) => e.email);
  assert.deepEqual(saved, ["timeout-site@example.org"], JSON.stringify(storage.emails));
});

function queueItem(host) {
  return { host, url: `https://${host}/`, pageUrl: `https://${host}/contact`, reason: "test", at: Date.now() };
}

test("the Close review tabs button closes the tabs opened by Approve", async () => {
  resetWorld();
  storage.queue = [queueItem("xi-review.com")];
  await ask({ type: "approveQueued", host: "xi-review.com" });
  assert.equal(tabs.size, 1, "the review tab is open");
  await ask({ type: "closeReviewTabs" });
  assert.equal(tabs.size, 0, `still open: ${[...tabs.keys()].join(", ")}`);
});

test("a review tab closes a few seconds after its form is submitted and the page moves on", async () => {
  resetWorld();
  storage.queue = [queueItem("pi-review.com")];
  await ask({ type: "approveQueued", host: "pi-review.com" });
  const [tabId] = [...tabs.keys()];
  assert.ok(tabId !== undefined, "the review tab is open");
  // The page moves on to a thank-you address after the submit.
  listeners.updated.forEach((fn) => fn(tabId, { url: "https://pi-review.com/thanks" }));
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(tabs.has(tabId), false, "the review tab closed after the submit");
});

test("a submit the site confirms is counted as sent", async () => {
  resetWorld();
  formOffered = true;
  await startRun("confirm-sent.com", { dryRun: false });
  await waitForIdle(20000);
  const row = (storage.log ?? []).find((e) => e.host === "confirm-sent.com");
  assert.equal(row?.status, "sent", JSON.stringify(storage.log));
  assert.ok(storage.sentHosts.includes("confirm-sent.com"));
  assert.match(notified[0].message, /1 confirmed sent/);
});

test("a submit with no confirmation is 'not confirmed', and that domain is never submitted to again", async () => {
  resetWorld();
  formOffered = true;
  submitVerdict = { outcome: "unverified", reason: "no confirmation, and the form is still there" };
  await startRun("no-confirm.com", { dryRun: false });
  await waitForIdle(20000);
  const row = (storage.log ?? []).find((e) => e.host === "no-confirm.com");
  assert.equal(row?.status, "sent?", JSON.stringify(storage.log));
  assert.ok(!(storage.log ?? []).some((e) => e.host === "no-confirm.com" && e.status === "sent"), "never counted as sent");
  await startRun("no-confirm.com", { dryRun: false });
  await waitForIdle(20000);
  const again = (storage.log ?? []).filter((e) => e.host === "no-confirm.com").map((e) => e.status);
  assert.deepEqual(again, ["sent?", "skipped"], "the second run skipped it");
});

test("a submit the site refuses goes back to the review queue and is not counted as sent", async () => {
  resetWorld();
  formOffered = true;
  submitVerdict = { outcome: "rejected", reason: "a required field is empty or invalid" };
  await startRun("refused.com", { dryRun: false });
  await waitForIdle(20000);
  const row = (storage.log ?? []).find((e) => e.host === "refused.com");
  assert.equal(row?.status, "queued", JSON.stringify(storage.log));
  assert.match(row.reason, /rejected: a required field/);
  assert.ok((storage.queue ?? []).some((q) => q.host === "refused.com"), "it is in the review queue");
  assert.ok(!(storage.sentHosts ?? []).includes("refused.com"), "it was not recorded as sent");
  assert.equal(notified[0].message.includes("1 confirmed sent"), false);
});

test("five domains are worked on at once, each in its own tab, and all of them finish", async () => {
  resetWorld();
  slowMs = 150;
  const hosts = ["one-fast.com", "two-fast.com", "three-fast.com", "four-fast.com", "five-fast.com", "six-fast.com", "seven-fast.com"];
  await startRun(hosts.join("\n"), { dryRun: false });
  await waitForIdle(30000);
  assert.equal(peakOpen, 5, `most tabs open at once: ${peakOpen}`);
  assert.equal(tabs.size, 0, "every tab was closed");
  const logged = (storage.log ?? []).filter((e) => hosts.includes(e.host)).map((e) => e.host);
  assert.equal(new Set(logged).size, hosts.length, `every domain has a result: ${JSON.stringify(storage.log)}`);
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
