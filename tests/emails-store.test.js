// Email extraction rule: addresses are saved only for sites with no usable form.
// Uses a real headless browser against small local sites. Nothing is submitted (dry run).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { createStore } from "../server/store.js";
import { Engine } from "../server/engine.js";
import { parseDomainList } from "../src/lib/normalize.js";

const WITH_FORM = {
  "/": `<!doctype html><html lang="en"><body><h1>Acme</h1>
    <a href="/contact.html">Contact us</a>
    <footer>Write to info@test-company.example</footer></body></html>`,
  "/contact.html": `<!doctype html><html lang="en"><body><h1>Contact</h1>
    <form method="post" action="/thanks.html">
      <label>Name <input name="name" type="text"></label>
      <label>Email <input name="email" type="email"></label>
      <label>Message <textarea name="message"></textarea></label>
      <button type="submit">Send</button>
    </form>
    <p>Sales: sales@test-company.example</p></body></html>`,
};

const NO_FORM = {
  "/": `<!doctype html><html lang="en"><body><h1>Shop</h1>
    <p>Call us, or write to hello@no-form-shop.example</p>
    <p>Press: press@no-form-shop.example</p></body></html>`,
};

async function startSite(pages) {
  const server = http.createServer((req, res) => {
    const body = pages[req.url.split("?")[0]];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(body ?? "<html><body>not found</body></html>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port };
}

async function runDomain(pages) {
  const site = await startSite(pages);
  try {
    const store = createStore(mkdtempSync(path.join(os.tmpdir(), "fh-emails-")));
    await store.load();
    store.set({ profile: { ...store.get().profile, firstName: "Pat", lastName: "Tester", email: "pat@example.com" } });
    const engine = new Engine(store, { launchOptions: { args: ["--no-sandbox", "--disable-dev-shm-usage"] } });
    engine.start(parseDomainList(`http://127.0.0.1:${site.port}/`), { dryRun: true });
    await engine.current;
    return { store, log: store.get().log, port: site.port };
  } finally {
    await new Promise((r) => site.server.close(r));
  }
}

test("a site with a contact form saves no addresses", async () => {
  const { store, log } = await runDomain(WITH_FORM);
  assert.ok(log.some((e) => e.status === "skipped" && /dry-run/.test(e.reason)), `a form was filled: ${JSON.stringify(log)}`);
  assert.deepEqual(store.get().emails, []);
});

test("a site with no usable form saves every address on its pages", async () => {
  const { store, log } = await runDomain(NO_FORM);
  assert.ok(log.some((e) => e.status === "queued"), `no form, so queued: ${JSON.stringify(log)}`);
  const saved = store.get().emails.map((e) => e.email).sort();
  assert.deepEqual(saved, ["hello@no-form-shop.example", "press@no-form-shop.example"]);
});
