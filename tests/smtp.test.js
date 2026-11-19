// Relay settings tests: encryption of the saved password, settings precedence, and the /api/smtp routes.
// No email is sent. The relay is replaced by a fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { createStore } from "../server/store.js";
import { CampaignRunner } from "../server/campaign.js";
import { createApp } from "../server/app.js";
import { encryptSecret, decryptSecret, resolveSmtp } from "../server/mailer.js";

const TOKEN = "smtp-test-token-0123456789abcdefgh";
const PLAIN = "relay-password-XYZ-123";

async function newStore() {
  const store = createStore(mkdtempSync(path.join(os.tmpdir(), "fh-smtp-")));
  await store.load();
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

test("the saved password round-trips, and the ciphertext does not contain it", () => {
  const stored = encryptSecret(PLAIN, TOKEN);
  assert.ok(!stored.includes(PLAIN));
  assert.equal(decryptSecret(stored, TOKEN), PLAIN);
});

test("a password cannot be read with a different token", () => {
  const stored = encryptSecret(PLAIN, TOKEN);
  assert.throws(() => decryptSecret(stored, "another-token-that-is-long-enough-123"));
});

test("saved settings win over environment variables, and the environment fills the gaps", () => {
  const env = { SMTP_HOST: "env.example.com", SMTP_PORT: "2525", SMTP_USER: "envuser", SMTP_PASS: "envpass", EMAIL_FROM: "env@example.com" };
  const saved = { host: "saved.example.com", port: 587, user: "", from: "", passEnc: encryptSecret("savedpass", TOKEN) };
  const smtp = resolveSmtp(saved, env, TOKEN);
  assert.equal(smtp.host, "saved.example.com");
  assert.equal(smtp.pass, "savedpass");
  assert.equal(smtp.from, "env@example.com"); // blank in settings, so taken from the environment
  assert.equal(smtp.source, "settings");

  const fromEnvOnly = resolveSmtp({}, env, TOKEN);
  assert.equal(fromEnvOnly.host, "env.example.com");
  assert.equal(fromEnvOnly.port, 2525);
  assert.equal(fromEnvOnly.pass, "envpass");
  assert.equal(fromEnvOnly.source, "environment");

  assert.equal(resolveSmtp({}, {}, TOKEN), null);
});

test("PUT stores the password encrypted, and GET never returns it", async () => {
  const store = await newStore();
  const srv = await serve(store, null);
  try {
    let r = await srv.call("/api/smtp", {
      method: "PUT",
      body: { host: "smtp.provider.com", port: 587, user: "login", from: "outreach@example.com", password: PLAIN },
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.passwordSaved, true);
    assert.ok(!JSON.stringify(body).includes(PLAIN));

    assert.ok(!JSON.stringify(store.get().smtp).includes(PLAIN));
    assert.equal(decryptSecret(store.get().smtp.passEnc, TOKEN), PLAIN);

    r = await srv.call("/api/smtp");
    const view = await r.json();
    assert.equal(view.host, "smtp.provider.com");
    assert.equal(view.from, "outreach@example.com");
    assert.ok(!JSON.stringify(view).includes(PLAIN));
  } finally {
    srv.close();
  }
});

test("leaving the password blank keeps the saved one; clearPassword removes it", async () => {
  const store = await newStore();
  const srv = await serve(store, null);
  try {
    await srv.call("/api/smtp", { method: "PUT", body: { host: "smtp.provider.com", port: 587, from: "a@example.com", password: PLAIN } });
    const kept = store.get().smtp.passEnc;
    await srv.call("/api/smtp", { method: "PUT", body: { host: "smtp.new.com", port: 587, from: "a@example.com", password: "" } });
    assert.equal(store.get().smtp.passEnc, kept);
    assert.equal(store.get().smtp.host, "smtp.new.com");

    const r = await srv.call("/api/smtp", { method: "PUT", body: { host: "smtp.new.com", port: 587, from: "a@example.com", clearPassword: true } });
    assert.equal((await r.json()).passwordSaved, false);
    assert.equal(store.get().smtp.passEnc, "");
  } finally {
    srv.close();
  }
});

test("bad relay settings are refused", async () => {
  const store = await newStore();
  const srv = await serve(store, null);
  try {
    const bad = [
      { host: "smtp bad host", port: 587, from: "a@example.com" },
      { host: "smtp.ok.com", port: 99999, from: "a@example.com" },
      { host: "smtp.ok.com", port: 587, from: "not-an-address" },
      { host: "smtp.ok.com", port: 587, from: "a@example.com", password: 12345 },
    ];
    for (const body of bad) {
      const r = await srv.call("/api/smtp", { method: "PUT", body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal(store.get().smtp.host, ""); // nothing was saved
  } finally {
    srv.close();
  }
});

test("the test send goes to the sender address, and needs a relay", async () => {
  const store = await newStore();
  const mailer = fakeMailer();
  let srv = await serve(store, mailer);
  try {
    const r = await srv.call("/api/smtp/test", { method: "POST" });
    assert.equal(r.status, 200);
    assert.equal(mailer.sent.length, 1);
    assert.equal(mailer.sent[0].to, "outreach@example.com");
  } finally {
    srv.close();
  }

  srv = await serve(store, null);
  try {
    const r = await srv.call("/api/smtp/test", { method: "POST" });
    assert.equal(r.status, 400);
  } finally {
    srv.close();
  }
});

test("smtp routes need the token", async () => {
  const store = await newStore();
  const srv = await serve(store, null);
  try {
    const r = await fetch(`${srv.base}/api/smtp`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 401);
    const r2 = await fetch(`${srv.base}/api/smtp/test`, { method: "POST" });
    assert.equal(r2.status, 401);
    assert.equal(store.get().smtp.host, "");
  } finally {
    srv.close();
  }
});
