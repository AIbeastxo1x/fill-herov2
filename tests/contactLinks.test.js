import { test } from "node:test";
import assert from "node:assert/strict";
import { findContactLinks } from "../src/lib/contactLinks.js";

test("matches contact links on same host, absolute, deduped", () => {
  const out = findContactLinks(
    [{ href: "/contact", text: "Contact Us" }, { href: "https://example.com/contact", text: "Contact" }, { href: "/about", text: "About" }],
    "https://example.com/"
  );
  assert.deepEqual(out, ["https://example.com/contact"]);
});
test("ignores other hosts and falls back", () => {
  const out = findContactLinks([{ href: "https://other.com/contact", text: "Contact" }], "https://example.com/");
  assert.deepEqual(out, ["https://example.com/contact", "https://example.com/contact-us"]);
});
test("treats www and bare host as the same site", () => {
  const out = findContactLinks(
    [{ href: "/contact/", text: "CONTACTEZ-NOUS" }],
    "https://www.enag.fr/"
  );
  assert.deepEqual(out, ["https://www.enag.fr/contact/"]);
  const fromBare = findContactLinks([{ href: "https://www.enag.fr/contact/", text: "Contact" }], "https://enag.fr/");
  assert.deepEqual(fromBare, ["https://www.enag.fr/contact/"]);
});
test("falls back to common paths when no link matches", () => {
  assert.deepEqual(findContactLinks([], "https://example.com/"), ["https://example.com/contact", "https://example.com/contact-us"]);
});
