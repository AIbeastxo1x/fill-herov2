// The page script (extension/content.js) in a real headless browser, against small local sites.
// A submit counts as confirmed only when the site shows it, and a refused submit is never confirmed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_JS = readFileSync(path.join(HERE, "..", "extension", "content.js"), "utf8");

const FORM = (extra = "", attrs = "") => `
  <form method="post" action="/thanks.html" ${attrs}>
    <label>Name <input name="name" type="text" ${extra}></label>
    <label>Email <input name="email" type="email"></label>
    <label>Message <textarea name="message"></textarea></label>
    <button type="submit">Send</button>
  </form>`;

const PAGES = {
  // The page shows a thank-you message after the form is sent, with no page change.
  "/shows-thanks": `<!doctype html><html><body><h1>Contact</h1>${FORM()}
    <script>document.querySelector("form").addEventListener("submit", (e) => { e.preventDefault();
      document.body.insertAdjacentHTML("beforeend", "<p>Thank you for your message.</p>"); });</script></body></html>`,
  // A required field is empty: the browser refuses to send, and no thank-you ever appears.
  "/needs-name": `<!doctype html><html><body><h1>Contact</h1>${FORM("required")}</body></html>`,
  // Nothing happens after the submit: no thank-you, no error.
  "/silent": `<!doctype html><html><body><h1>Contact</h1>${FORM()}
    <script>document.querySelector("form").addEventListener("submit", (e) => e.preventDefault());</script></body></html>`,
  // The site shows an error after the submit.
  "/shows-error": `<!doctype html><html><body><h1>Contact</h1>${FORM()}
    <script>document.querySelector("form").addEventListener("submit", (e) => { e.preventDefault();
      document.body.insertAdjacentHTML("beforeend", '<div role="alert">Sorry, the message could not be sent. Please try again.</div>'); });</script></body></html>`,
  // A full page post that lands on a thank-you page.
  "/posts-to-thanks": `<!doctype html><html><body><h1>Contact</h1>${FORM()}</body></html>`,
  "/thanks.html": `<!doctype html><html><body><h1>Thanks</h1><p>Thank you for getting in touch.</p></body></html>`,
};

let server;
let base;
let browser;

before(async () => {
  server = http.createServer((req, res) => {
    const pathname = req.url.split("?")[0];
    // The form posts to /thanks.html; the thank-you page is served for that path.
    if (req.method === "POST" && pathname === "/thanks.html") {
      res.writeHead(303, { location: "/thanks.html" });
      return res.end();
    }
    const body = PAGES[pathname];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(body ?? "not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
});

after(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
});

// Opens a page, loads the page script, fills the form, and submits it.
// A page that moves on during the submit ends the page script, so that case returns { gone: true }.
async function submitTo(pathname, fills = [{ index: 0, value: "Pat" }, { index: 1, value: "pat@example.com" }, { index: 2, value: "Hello" }]) {
  const page = await browser.newPage();
  await page.goto(base + pathname);
  await page.addScriptTag({ content: CONTENT_JS });
  await page.evaluate((f) => window.__fillHero.fill(0, f), fills);
  const url = page.url();
  const verdict = await page.evaluate(() => window.__fillHero.submit(0, location.href)).catch(() => ({ gone: true }));
  return { page, url, verdict };
}

test("a site that shows a thank-you message confirms the submit", async () => {
  const { page, verdict } = await submitTo("/shows-thanks");
  assert.equal(verdict.outcome, "confirmed", JSON.stringify(verdict));
  await page.close();
});

test("a required field left empty is refused: rejected, never confirmed", async () => {
  // The name box is left empty, and it is required.
  const { page, verdict } = await submitTo("/needs-name", [{ index: 1, value: "pat@example.com" }, { index: 2, value: "Hello" }]);
  assert.equal(verdict.outcome, "rejected", JSON.stringify(verdict));
  assert.match(verdict.reason, /required field/);
  await page.close();
});

test("a site that shows an error is rejected, not confirmed", async () => {
  const { page, verdict } = await submitTo("/shows-error");
  assert.equal(verdict.outcome, "rejected", JSON.stringify(verdict));
  await page.close();
});

test("a submit with no sign either way is unverified, never confirmed", async () => {
  const { page, verdict } = await submitTo("/silent");
  assert.equal(verdict.outcome, "unverified", JSON.stringify(verdict));
  await page.close();
});

test("a full page post is confirmed from the page it lands on", async () => {
  const { page, url, verdict: during } = await submitTo("/posts-to-thanks");
  assert.deepEqual(during, { gone: true }, "the page moved on during the submit");
  // The page moved on to the thank-you page, so the old script is gone. Read it there.
  await page.waitForURL(/thanks\.html/, { timeout: 10000 });
  await page.waitForLoadState("load");
  await page.addScriptTag({ content: CONTENT_JS });
  const verdict = await page.evaluate((startUrl) => window.__fillHero.confirm(0, startUrl), url);
  assert.equal(verdict.outcome, "confirmed", JSON.stringify(verdict));
  await page.close();
});
