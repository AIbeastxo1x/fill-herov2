import { test } from "node:test";
import assert from "node:assert/strict";
import { extractEmails, emailsToCsv } from "../src/lib/emails.js";

test("finds addresses in text and mailto links, lower-cased and unique", () => {
  const html = `<a href="mailto:Sales@Example.com?subject=Hi">mail</a> Contact info@example.com or sales@example.com.`;
  assert.deepEqual(extractEmails(html), ["sales@example.com", "info@example.com"]);
});

test("decodes HTML-encoded at signs", () => {
  assert.deepEqual(extractEmails("jane&#64;firm.ie"), ["jane@firm.ie"]);
  assert.deepEqual(extractEmails("jane&commat;firm.ie"), ["jane@firm.ie"]);
});

test("drops image and asset names that look like addresses", () => {
  assert.deepEqual(extractEmails('<img src="logo@2x.png"> <script src="app@1.js">'), []);
});

test("returns nothing for empty input", () => {
  assert.deepEqual(extractEmails(""), []);
  assert.deepEqual(extractEmails(undefined), []);
});

test("csv has a header and quotes values that need it", () => {
  const csv = emailsToCsv([{ host: "a.com", email: "x@a.com", pageUrl: "https://a.com/contact", at: 0 }]);
  const [header, row] = csv.split("\n");
  assert.equal(header, "host,email,pageUrl,at");
  assert.equal(row, "a.com,x@a.com,https://a.com/contact,1970-01-01T00:00:00.000Z");
});
