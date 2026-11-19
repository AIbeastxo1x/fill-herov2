// Consented contacts tests: import rules, duplicate and do-not-email handling, and campaign recipients.
// No email is sent. The relay is replaced by a fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { createStore } from "../server/store.js";
import { CampaignRunner, pendingRecipients } from "../server/campaign.js";
import { createApp } from "../server/app.js";

const TOKEN = "contacts-test-token-0123456789abcdefgh";
const TODAY = new Date().toISOString().slice(0, 10);

async function newStore(extra = {}) {
  const store = createStore(mkdtempSync(path.join(os.tmpdir(), "fh-contacts-")));
  await store.load();
  store.set({
    profile: { ...store.get().profile, address: "1 Main Street", city: "Dublin" },
    campaign: { subject: "Hello {domain}", body: "We would like to talk." },
    ...extra,
  });
  await store.flush();
  return store;
}

function fakeMailer() {
  const sent = [];
  return { from: "outreach@example.com", sent, send: async (m) => { sent.push(m); } };
}

async function serve(store, mailer) {
  const campaigns = new CampaignRunner(store, { mailer: () => mailer, sleep: async () => {} });
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
  return { call, base, close: () => server.close() };
}

test("import needs a consent source and a real past date", async () => {
  const store = await newStore();
  const srv = await serve(store, null);
  try {
    let r = await srv.call("/api/contacts/import", { method: "POST", body: { text: "a@x.com", consentSource: "", consentDate: TODAY } });
    assert.equal(r.status, 400);
    r = await srv.call("/api/contacts/import", { method: "POST", body: { text: "a@x.com", consentSource: "signup", consentDate: "2026-02-31" } });
    assert.equal(r.status, 400);
    r = await srv.call("/api/contacts/import", { method: "POST", body: { text: "a@x.com", consentSource: "signup", consentDate: "2999-01-01" } });
    assert.equal(r.status, 400);
    assert.equal(store.get().contacts.length, 0);
  } finally {
    srv.close();
  }
});

test("valid lines are added with their consent details, bad lines are reported", async () => {
  const store = await newStore();
  const srv = await serve(store, null);
  try {
    const r = await srv.call("/api/contacts/import", {
      method: "POST",
      body: { text: "Jane@Company.com, Jane Smith\nnot-an-email\nbob@shop.org\n", consentSource: "Website sign-up form", consentDate: "2026-01-15" },
    });
    const d = await r.json();
    assert.equal(d.added, 2);
    assert.equal(d.invalid, 1);
    assert.deepEqual(store.get().contacts.map((c) => c.email), ["jane@company.com", "bob@shop.org"]);
    assert.equal(store.get().contacts[0].name, "Jane Smith");
    assert.equal(store.get().contacts[0].consentSource, "Website sign-up form");
    assert.equal(store.get().contacts[0].consentDate, "2026-01-15");
  } finally {
    srv.close();
  }
});

test("duplicates and do-not-email addresses are not added", async () => {
  const store = await newStore({ suppressed: ["blocked@x.com"] });
  const srv = await serve(store, null);
  try {
    await srv.call("/api/contacts/import", { method: "POST", body: { text: "a@x.com", consentSource: "signup", consentDate: "2026-01-15" } });
    const r = await srv.call("/api/contacts/import", {
      method: "POST",
      body: { text: "a@x.com\nblocked@x.com", consentSource: "signup", consentDate: "2026-01-15" },
    });
    const d = await r.json();
    assert.equal(d.added, 0);
    assert.equal(d.duplicates, 1);
    assert.equal(d.onDoNotEmailList, 1);
    assert.equal(store.get().contacts.length, 1);
  } finally {
    srv.close();
  }
});

test("the summary counts contacts by consent source", async () => {
  const store = await newStore();
  const srv = await serve(store, null);
  try {
    await srv.call("/api/contacts/import", { method: "POST", body: { text: "a@x.com\nb@x.com", consentSource: "signup", consentDate: "2026-01-15" } });
    await srv.call("/api/contacts/import", { method: "POST", body: { text: "c@x.com", consentSource: "trade fair", consentDate: "2026-02-01" } });
    const s = await (await srv.call("/api/contacts")).json();
    assert.equal(s.count, 3);
    assert.deepEqual(s.bySource.sort((a, b) => a.source.localeCompare(b.source)), [
      { source: "signup", count: 2 },
      { source: "trade fair", count: 1 },
    ]);
  } finally {
    srv.close();
  }
});

test("campaign emails go only to consented contacts, not to addresses found on websites", async () => {
  const store = await newStore({
    emails: [{ host: "site.com", email: "found-on-site@site.com" }],
    contacts: [{ email: "jane@company.com", consentSource: "signup", consentDate: "2026-01-15" }],
  });
  const mailer = fakeMailer();
  const runner = new CampaignRunner(store, { mailer, sleep: async () => {} });
  assert.deepEqual(pendingRecipients(store.get()).map((r) => r.email), ["jane@company.com"]);
  runner.start({ dryRun: false });
  await runner.current;
  assert.deepEqual(mailer.sent.map((m) => m.to), ["jane@company.com"]);
});

test("clearing the contact list keeps the send record and the do-not-email list", async () => {
  const store = await newStore({
    contacts: [{ email: "jane@company.com", consentSource: "signup", consentDate: "2026-01-15" }],
    emailLog: [{ email: "jane@company.com", status: "sent" }],
    suppressed: ["stop@x.com"],
  });
  const srv = await serve(store, null);
  try {
    const r = await srv.call("/api/contacts/clear", { method: "POST" });
    assert.equal(r.status, 200);
    assert.equal(store.get().contacts.length, 0);
    assert.equal(store.get().emailLog.length, 1);
    assert.deepEqual(store.get().suppressed, ["stop@x.com"]);
  } finally {
    srv.close();
  }
});

test("contacts routes need the token", async () => {
  const store = await newStore();
  const srv = await serve(store, null);
  try {
    const r = await fetch(`${srv.base}/api/contacts`);
    assert.equal(r.status, 401);
  } finally {
    srv.close();
  }
});
