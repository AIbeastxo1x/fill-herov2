import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEmailsFile, buildCaptchaFile, dataUrl, EMAIL_FILE, CAPTCHA_FILE } from "../src/lib/files.js";

const NOW = Date.parse("2026-11-19T10:00:00Z");

test("file names sit in the FillHero subfolder", () => {
  assert.equal(EMAIL_FILE, "FillHero/extractedemails.txt");
  assert.equal(CAPTCHA_FILE, "FillHero/captcha_domains.txt");
});

test("emails file: unique, sorted, one per line with its host", () => {
  const text = buildEmailsFile(
    [
      { host: "b.com", email: "sales@b.com", at: 1 },
      { host: "a.com", email: "info@a.com", at: 2 },
      { host: "c.com", email: "info@a.com", at: 3 },
    ],
    NOW
  );
  const lines = text.split("\r\n");
  assert.equal(lines[0], "# Fill Hero - extracted email addresses");
  assert.equal(lines[1], "# 2 unique address(es), updated 2026-11-19T10:00:00.000Z");
  assert.deepEqual(lines.slice(3, 5), ["info@a.com\ta.com", "sales@b.com\tb.com"]);
});

test("captcha file: one domain per line, sorted by host", () => {
  const text = buildCaptchaFile(
    [
      { host: "z.com", pageUrl: "https://z.com/contact", at: Date.parse("2026-11-18T09:00:00Z") },
      { host: "a.com", pageUrl: "https://a.com/contact", at: Date.parse("2026-11-18T08:00:00Z") },
    ],
    NOW
  );
  const lines = text.split("\r\n");
  assert.equal(lines[1], "# 2 domain(s), updated 2026-11-19T10:00:00.000Z");
  assert.deepEqual(lines.slice(3, 5), [
    "a.com\thttps://a.com/contact\t2026-11-18T08:00:00.000Z",
    "z.com\thttps://z.com/contact\t2026-11-18T09:00:00.000Z",
  ]);
});

test("empty lists still produce a valid header-only file", () => {
  assert.match(buildEmailsFile([], NOW), /^# Fill Hero - extracted email addresses\r\n# 0 unique/);
});

test("data url is UTF-8 text and round-trips", () => {
  const url = dataUrl("a@b.com\tcafé");
  assert.ok(url.startsWith("data:text/plain;charset=utf-8,"));
  assert.equal(decodeURIComponent(url.split(",")[1]), "a@b.com\tcafé");
});
