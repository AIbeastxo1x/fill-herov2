import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDomain, parseDomainList } from "../src/lib/normalize.js";

test("bare domain becomes https url", () => {
  assert.deepEqual(normalizeDomain("example.com"), { ok: true, url: "https://example.com/", host: "example.com" });
});
test("trims, lowercases host, strips path", () => {
  assert.equal(normalizeDomain("  HTTPS://Example.COM/about/ ").host, "example.com");
});
test("rejects empty and scheme-only input", () => {
  assert.equal(normalizeDomain("").ok, false);
  assert.equal(normalizeDomain("http://").ok, false);
});
test("rejects single-label hosts other than localhost", () => {
  assert.equal(normalizeDomain("intranet").ok, false);
});
test("keeps scheme and port for localhost test servers", () => {
  assert.deepEqual(normalizeDomain("http://localhost:8000/contact.html"), {
    ok: true,
    url: "http://localhost:8000/",
    host: "localhost:8000",
  });
});
test("parseDomainList splits lines and commas, skips blanks", () => {
  const out = parseDomainList("a.com\n\nb.com, c.com");
  assert.equal(out.length, 3);
  assert.equal(out.every((r) => r.ok), true);
});
