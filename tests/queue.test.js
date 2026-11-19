import { test } from "node:test";
import assert from "node:assert/strict";
import { addLog, hasSent, logToCsv } from "../src/lib/queue.js";

test("addLog returns a new array with the entry appended", () => {
  const before = [];
  const after = addLog(before, { host: "a.com", status: "sent", reason: "ok", pageUrl: "https://a.com/contact", at: 1 });
  assert.equal(before.length, 0);
  assert.equal(after.length, 1);
});
test("hasSent is true for sent and sent?", () => {
  assert.equal(hasSent([{ host: "a.com", status: "sent?" }], "a.com"), true);
  assert.equal(hasSent([{ host: "a.com", status: "queued" }], "a.com"), false);
  assert.equal(hasSent([{ host: "b.com", status: "sent" }], "a.com"), false);
});
test("logToCsv escapes commas and quotes", () => {
  const csv = logToCsv([{ host: "a.com", status: "queued", reason: 'has "pw", x', pageUrl: "https://a.com/contact", at: 0 }]);
  const lines = csv.split("\n");
  assert.equal(lines[0], "host,status,reason,pageUrl,at");
  assert.match(lines[1], /"has ""pw"", x"/);
});
