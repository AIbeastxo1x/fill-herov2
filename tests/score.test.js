import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreForm, detectCaptcha } from "../src/lib/score.js";

const f = (fields, extra = {}) => ({ fields, hasPassword: false, action: "/contact", ...extra });
const field = (o) => ({ tag: "input", type: "text", name: "", id: "", placeholder: "", autocomplete: "", label: "", required: false, ...o });

test("name+email+textarea scores high", () => {
  const r = scoreForm(f([field({ name: "name" }), field({ type: "email" }), field({ tag: "textarea" })]));
  assert.equal(r.level, "high");
  assert.equal(r.reason, "ok");
  assert.equal(r.fieldMap.message, 2);
});
test("newsletter-only (email, no message) scores low", () => {
  assert.equal(scoreForm(f([field({ type: "email" })])).reason, "no-message-field");
});
test("password form scores low", () => {
  assert.equal(scoreForm(f([field({ type: "email" }), field({ tag: "textarea" })], { hasPassword: true })).reason, "has-password");
});
test("required dropdown scores low", () => {
  const r = scoreForm(f([field({ type: "email" }), field({ tag: "textarea" }), field({ tag: "select", required: true })]));
  assert.equal(r.level, "low");
  assert.equal(r.reason, "unmapped-required");
});
test("required consent checkbox scores low", () => {
  const r = scoreForm(f([field({ type: "email" }), field({ tag: "textarea" }), field({ type: "checkbox", required: true })]));
  assert.equal(r.reason, "consent-required");
});
test("detects recaptcha iframe", () => {
  assert.equal(detectCaptcha({ iframeSrcs: ["https://www.google.com/recaptcha/api2/anchor"], classNames: [] }), true);
});
test("no captcha signals", () => {
  assert.equal(detectCaptcha({ iframeSrcs: [], classNames: ["btn"] }), false);
});
