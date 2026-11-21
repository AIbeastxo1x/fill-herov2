// Regression test: every email address on a domain is saved, even when a form was found and filled.
// Uses a real headless browser against a small local site. Nothing is submitted (dry run).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { createStore } from "../server/store.js";
import { Engine } from "../server/engine.js";
import { parseDomainList } from "../src/lib/normalize.js";

const PAGES = {
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

let site;
let port;

before(async () => {
  site = http.createServer((req, res) => {
    const body = PAGES[req.url.split("?")[0]];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(body ?? "<html><body>not found</body></html>");
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  port = site.address().port;
});

after(() => new Promise((r) => site.close(r)));

test("a domain with a form still saves every address found on its pages", async () => {
  const store = createStore(mkdtempSync(path.join(os.tmpdir(), "fh-emails-")));
  await store.load();
  store.set({ profile: { ...store.get().profile, firstName: "Pat", lastName: "Tester", email: "pat@example.com" } });
  const engine = new Engine(store, { launchOptions: { args: ["--no-sandbox", "--disable-dev-shm-usage"] } });

  engine.start(parseDomainList(`http://127.0.0.1:${port}/`), { dryRun: true });
  await engine.current;

  const log = store.get().log;
  assert.ok(log.some((e) => e.status === "skipped" && /dry-run/.test(e.reason)), `a form was filled: ${JSON.stringify(log)}`);

  const saved = store.get().emails.map((e) => e.email).sort();
  assert.deepEqual(saved, ["info@test-company.example", "sales@test-company.example"]);
  const info = store.get().emails.find((e) => e.email === "info@test-company.example");
  assert.match(info.pageUrl, new RegExp(`127\\.0\\.0\\.1:${port}/$`));
});
