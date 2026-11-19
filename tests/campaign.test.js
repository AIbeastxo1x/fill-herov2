// Email campaign tests. No email is sent: the relay is replaced by a fake that records messages.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { createStore } from "../server/store.js";
import { CampaignRunner, composeEmail, pendingRecipients, campaignLimitsFromEnv } from "../server/campaign.js";
import { createApp } from "../server/app.js";

const TOKEN = "campaign-test-token-0123456789abcdef";
const PROFILE = {
  firstName: "Pat",
  lastName: "Tester",
  company: "Acme",
  address: "1 Main Street",
  city: "Dublin",
  zip: "D01 X1Y2",
  country: "Ireland",
};

async function newStore(extra = {}) {
  const store = createStore(mkdtempSync(path.join(os.tmpdir(), "fh-camp-")));
  await store.load();
  store.set({
    profile: { ...store.get().profile, ...PROFILE },
    campaign: { subject: "Quote for {domain}", body: "Hello {domain} team,\n\nWe would like a quote." },
    contacts: [
      { email: "info@a.com", consentSource: "test", consentDate: "2026-01-01" },
      { email: "sales@b.com", consentSource: "test", consentDate: "2026-01-01" },
      { email: "sales@b.com", consentSource: "test", consentDate: "2026-01-01" },
      { email: "hello@c.com", consentSource: "test", consentDate: "2026-01-01" },
    ],
    ...extra,
  });
  await store.flush();
  return store;
}

function fakeMailer() {
  const sent = [];
  return {
    from: "outreach@example.com",
    sent,
    send: async (message) => {
      if (message.to === "fail@d.com") throw new Error("relay rejected");
      sent.push(message);
      return { messageId: "x" };
    },
  };
}

const noSleep = async () => {};

test("composed email fills the domain, adds the sender footer and an opt-out line", () => {
  const msg = composeEmail({
    subject: "Quote for {domain}",
    body: "Hello {domain} team.",
    profile: { ...PROFILE },
    host: "a.com",
    email: "info@a.com",
    from: "outreach@example.com",
    unsubscribeUrl: "https://site.example/unsubscribe?t=abc",
  });
  assert.equal(msg.subject, "Quote for a.com");
  assert.equal(msg.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.match(msg.headers["List-Unsubscribe"], /<https:\/\/site\.example\/unsubscribe\?t=abc>/);
  assert.match(msg.text, /Hello a\.com team\./);
  assert.match(msg.text, /Pat Tester, Acme/);
  assert.match(msg.text, /1 Main Street, Dublin, D01 X1Y2, Ireland/);
  assert.match(msg.text, /open this link: https:\/\/site\.example\/unsubscribe\?t=abc/);
  assert.equal(msg.to, "info@a.com");
});

test("recipients are unique and skip addresses already sent or suppressed", () => {
  const list = pendingRecipients({
    contacts: [
      { email: "info@a.com" },
      { email: "sales@b.com" },
      { email: "sales@b.com" },
      { email: "hello@c.com" },
    ],
    emailLog: [{ email: "info@a.com", status: "sent" }],
    suppressed: ["hello@c.com"],
  });
  assert.deepEqual(list.map((r) => r.email), ["sales@b.com"]);
});

test("a dry run composes every email and sends none", async () => {
  const store = await newStore();
  const mailer = fakeMailer();
  const runner = new CampaignRunner(store, { mailer, sleep: noSleep, publicBaseUrl: "https://site.example", unsubscribeSecret: "test-secret-0123456789abcdef" });
  runner.start({ dryRun: true });
  await runner.current;
  assert.equal(mailer.sent.length, 0);
  assert.equal(store.get().emailLog.filter((e) => e.status === "dry-run").length, 3);
});

test("a live run sends once to each address and never again", async () => {
  const store = await newStore();
  const mailer = fakeMailer();
  const runner = new CampaignRunner(store, { mailer, sleep: noSleep, publicBaseUrl: "https://site.example", unsubscribeSecret: "test-secret-0123456789abcdef" });
  runner.start({ dryRun: false });
  await runner.current;
  assert.deepEqual(mailer.sent.map((m) => m.to), ["info@a.com", "sales@b.com", "hello@c.com"]);
  assert.equal(pendingRecipients(store.get()).length, 0);

  runner.start({ dryRun: false });
  await runner.current;
  assert.equal(mailer.sent.length, 3);
});

test("the do-not-email list is never sent to", async () => {
  const store = await newStore({ suppressed: ["info@a.com"] });
  const mailer = fakeMailer();
  const runner = new CampaignRunner(store, { mailer, sleep: noSleep, publicBaseUrl: "https://site.example", unsubscribeSecret: "test-secret-0123456789abcdef" });
  runner.start({ dryRun: false });
  await runner.current;
  assert.ok(!mailer.sent.some((m) => m.to === "info@a.com"));
});

test("a failed send is recorded and the address is not marked as sent", async () => {
  const store = await newStore({
    contacts: [{ email: "fail@d.com", consentSource: "test", consentDate: "2026-01-01" }],
  });
  const runner = new CampaignRunner(store, { mailer: fakeMailer(), sleep: noSleep, publicBaseUrl: "https://site.example", unsubscribeSecret: "test-secret-0123456789abcdef" });
  runner.start({ dryRun: false });
  await runner.current;
  const entry = store.get().emailLog.find((e) => e.email === "fail@d.com");
  assert.equal(entry.status, "failed");
  assert.match(entry.reason, /relay rejected/);
  assert.equal(pendingRecipients(store.get()).length, 1);
});

test("the daily cap stops the run", async () => {
  const store = await newStore();
  const mailer = fakeMailer();
  const runner = new CampaignRunner(store, { mailer, dailyCap: 2, sleep: noSleep, publicBaseUrl: "https://site.example", unsubscribeSecret: "test-secret-0123456789abcdef" });
  runner.start({ dryRun: false });
  await runner.current;
  assert.equal(mailer.sent.length, 2);
  assert.ok(store.get().emailLog.some((e) => e.reason === "daily-cap"));
});

test("the gap is read from the environment with safe defaults", () => {
  assert.deepEqual(campaignLimitsFromEnv({}), { gapMs: 60000, dailyCap: 100 });
  assert.deepEqual(campaignLimitsFromEnv({ EMAIL_GAP_SECONDS: "30", EMAIL_DAILY_CAP: "40" }), { gapMs: 30000, dailyCap: 40 });
  assert.deepEqual(campaignLimitsFromEnv({ EMAIL_GAP_SECONDS: "abc", EMAIL_DAILY_CAP: "-5" }), { gapMs: 60000, dailyCap: 100 });
});

// ---------- routes ----------

async function serve(store, mailer) {
  const campaigns = new CampaignRunner(store, { mailer, sleep: noSleep, publicBaseUrl: "https://site.example", unsubscribeSecret: "test-secret-0123456789abcdef" });
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

test("live start is refused without a relay, and start needs a message and a postal address", async () => {
  const store = await newStore();
  const srv = await serve(store, null); // no relay configured
  try {
    let r = await srv.call("/api/campaign/start", { method: "POST", body: { dryRun: false } });
    assert.equal(r.status, 400); // no message yet

    await srv.call("/api/campaign", { method: "PUT", body: { subject: "Hi", body: "Hello" } });
    r = await srv.call("/api/campaign/start", { method: "POST", body: { dryRun: false } });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /SMTP relay/);

    r = await srv.call("/api/campaign/start", { method: "POST", body: { dryRun: true } });
    assert.equal(r.status, 202); // a dry run is fine without a relay
  } finally {
    srv.close();
  }
});

test("the postal address is required before any campaign starts", async () => {
  const store = await newStore({ profile: { ...PROFILE, address: "", city: "" } });
  const srv = await serve(store, fakeMailer());
  try {
    await srv.call("/api/campaign", { method: "PUT", body: { subject: "Hi", body: "Hello" } });
    const r = await srv.call("/api/campaign/start", { method: "POST", body: { dryRun: true } });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /postal address/);
  } finally {
    srv.close();
  }
});

test("suppress adds addresses, and the summary shows the counts", async () => {
  const store = await newStore();
  const srv = await serve(store, fakeMailer());
  try {
    const r = await srv.call("/api/campaign/suppress", { method: "POST", body: { emails: "Info@A.com, bad-line\nnew@x.org" } });
    assert.equal(r.status, 200);
    assert.deepEqual(store.get().suppressed.sort(), ["info@a.com", "new@x.org"]);

    const s = await (await srv.call("/api/campaign")).json();
    assert.equal(s.suppressed, 2);
    assert.equal(s.recipients, 2); // info@a.com is suppressed, so sales@b.com and hello@c.com remain
    assert.equal(s.configured, true);
  } finally {
    srv.close();
  }
});

test("campaign routes need the token", async () => {
  const store = await newStore();
  const srv = await serve(store, fakeMailer());
  try {
    const base = srv.base;
    const r = await fetch(`${base}/api/campaign`);
    assert.equal(r.status, 401);
    const r2 = await fetch(`${base}/api/campaign/start`, { method: "POST" });
    assert.equal(r2.status, 401);
    assert.equal(store.get().emailLog.length, 0);
  } finally {
    srv.close();
  }
});
