import { test } from "node:test";
import assert from "node:assert/strict";
import { canSubmit, nextState } from "../src/lib/rateLimit.js";

const limits = { gapMs: 60000, dailyCap: 50 };
const now = Date.parse("2026-11-17T12:00:00");
const base = { lastSubmitAt: 0, dailyCount: 0, dailyDate: "2026-11-17" };

test("allowed when gap has passed", () => {
  assert.deepEqual(canSubmit(base, now, limits), { ok: true, waitMs: 0 });
});
test("waits for gap", () => {
  const r = canSubmit({ ...base, lastSubmitAt: now - 30000 }, now, limits);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "gap");
  assert.equal(r.waitMs, 30000);
});
test("blocks at daily cap", () => {
  assert.equal(canSubmit({ ...base, dailyCount: 50 }, now, limits).reason, "daily-cap");
});
test("stale date counts as zero", () => {
  assert.equal(canSubmit({ lastSubmitAt: 0, dailyCount: 50, dailyDate: "2026-11-16" }, now, limits).ok, true);
});
test("nextState resets count on new day", () => {
  const s = nextState({ lastSubmitAt: 0, dailyCount: 50, dailyDate: "2026-11-16" }, now);
  assert.equal(s.dailyCount, 1);
  assert.equal(s.dailyDate, "2026-11-17");
  assert.equal(s.lastSubmitAt, now);
});
