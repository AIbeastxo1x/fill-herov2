// Form descriptors captured from real pages (src/content.js scan() output).
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreForm } from "../src/lib/score.js";

const f = (label, type, name, required = false, tag = "input") => ({
  tag, type, name, id: "", placeholder: "", autocomplete: "", label, required,
});

// https://www.bbeinc.com/contact (live form, scanned from the page)
const bbeForm = {
  index: 0,
  hasPassword: false,
  action: "https://www.bbeinc.com/contact",
  fields: [
    f("First Name", "text", "first-name", true),
    f("Last Name", "text", "last-name", true),
    f("Company", "text", "company", true),
    f("Email", "email", "email", true),
    f("Subject", "text", "subject"),
    f("Comment or Message", "textarea", "", false, "textarea"),
  ],
};

// Local fixture test-site/contact.html mirrors the same layout.
const passwordForm = {
  index: 0,
  hasPassword: true,
  action: "login.html",
  fields: [
    f("", "email", "email"),
    f("", "password", "password"),
    f("", "textarea", "notes", false, "textarea"),
  ],
};

test("bbe contact form scores high with the expected field map", () => {
  const r = scoreForm(bbeForm);
  assert.equal(r.level, "high");
  assert.deepEqual(r.fieldMap, { firstName: 0, lastName: 1, company: 2, email: 3, subject: 4, message: 5 });
});

test("password form is rejected", () => {
  assert.equal(scoreForm(passwordForm).reason, "has-password");
});
