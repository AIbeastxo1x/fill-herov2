import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFillPlan, detectPlatform, detectFormType, summarizePlan } from "../src/lib/fillPlan.js";

const f = (label, type, name, required = false, tag = "input") => ({
  tag, type, name, id: "", placeholder: "", autocomplete: "", label, required,
});

// Scanned from https://www.bbeinc.com/contact
const bbeForm = {
  index: 0,
  hasPassword: false,
  action: "https://www.bbeinc.com/contact",
  id: "",
  className: "",
  fields: [
    f("First Name", "text", "first-name", true),
    f("Last Name", "text", "last-name", true),
    f("Company", "text", "company", true),
    f("Email", "email", "email", true),
    f("Subject", "text", "subject"),
    f("Comment or Message", "textarea", "", false, "textarea"),
  ],
};

const profile = {
  firstName: "Pat",
  lastName: "Tester",
  company: "Acme",
  email: "pat@example.com",
  phone: "",
  subject: "Quote request",
  template: "Hello {domain} team, from {company}.",
};

test("fills every mapped field on the bbe form, including the message textarea", () => {
  const plan = buildFillPlan(bbeForm, profile, "bbeinc.com");
  assert.equal(plan.type, "contact");
  const byRole = Object.fromEntries(plan.fills.map((x) => [x.role, x]));
  assert.equal(byRole.firstName.index, 0);
  assert.equal(byRole.lastName.index, 1);
  assert.equal(byRole.company.index, 2);
  assert.equal(byRole.email.index, 3);
  assert.equal(byRole.subject.value, "Quote request");
  assert.equal(byRole.message.index, 5);
  assert.equal(byRole.message.value, "Hello bbeinc.com team, from Acme.");
  assert.equal(plan.unfilled.length, 0);
});

test("an empty template is reported as unfilled, not silently skipped", () => {
  const plan = buildFillPlan(bbeForm, { ...profile, template: "" }, "bbeinc.com");
  assert.ok(plan.unfilled.some((u) => u.role === "message" && u.reason === "profile-empty"));
  assert.match(summarizePlan(plan, null), /unfilled=message/);
});

test("a blank required company is reported as required and unfilled", () => {
  const plan = buildFillPlan(bbeForm, { ...profile, company: "" }, "bbeinc.com");
  const u = plan.unfilled.find((x) => x.role === "company");
  assert.equal(u.required, true);
});

test("detects a message-only template", () => {
  const form = { fields: [f("", "email", "email"), f("", "textarea", "", false, "textarea")], hasPassword: false, id: "", className: "", action: "" };
  assert.equal(detectFormType(buildFillPlan(form, profile, "x.com").score), "message-only");
});

test("detects common platforms from id, class or action", () => {
  assert.equal(detectPlatform({ id: "wpcf7-f12-p34", className: "", action: "" }), "contact-form-7");
  assert.equal(detectPlatform({ id: "", className: "gform_wrapper", action: "" }), "gravity-forms");
  assert.equal(detectPlatform({ id: "", className: "hs-form", action: "" }), "hubspot");
  assert.equal(detectPlatform({ id: "comp-abc", className: "", action: "" }), "wix");
  assert.equal(detectPlatform({ id: "", className: "", action: "/x" }), "generic");
});
