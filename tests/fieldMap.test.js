import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyField } from "../src/lib/fieldMap.js";

const d = (o) => ({ tag: "input", type: "text", name: "", id: "", placeholder: "", autocomplete: "", label: "", required: false, ...o });

test("email by type", () => assert.equal(classifyField(d({ type: "email" })), "email"));
test("email by name keyword", () => assert.equal(classifyField(d({ name: "your_email" })), "email"));
test("first name by hyphenated name", () => assert.equal(classifyField(d({ name: "first-name" })), "firstName"));
test("first name by label", () => assert.equal(classifyField(d({ label: "First Name" })), "firstName"));
test("last name by hyphenated name", () => assert.equal(classifyField(d({ name: "last-name" })), "lastName"));
test("last name is not mistaken for full name", () => assert.equal(classifyField(d({ label: "Last Name" })), "lastName"));
test("full name still maps to name", () => assert.equal(classifyField(d({ name: "fullname" })), "name"));
test("subject by label", () => assert.equal(classifyField(d({ name: "subject" })), "subject"));
test("phone by type", () => assert.equal(classifyField(d({ type: "tel" })), "phone"));
test("company by label", () => assert.equal(classifyField(d({ label: "Company" })), "company"));
test("textarea is message", () => assert.equal(classifyField(d({ tag: "textarea", label: "Comment or Message" })), "message"));
test("text input named comment is message", () => assert.equal(classifyField(d({ name: "comment" })), "message"));
test("French labels: Nom, Société, E-mail, objet, message", () => {
  assert.equal(classifyField(d({ label: "Nom*" })), "name");
  assert.equal(classifyField(d({ label: "Prénom" })), "firstName");
  assert.equal(classifyField(d({ label: "Société*" })), "company");
  assert.equal(classifyField(d({ type: "email", label: "E-mail*" })), "email");
  assert.equal(classifyField(d({ label: "Objet" })), "subject");
  assert.equal(classifyField(d({ tag: "textarea", label: "Merci de préciser l'objet de votre demande" })), "message");
});
test("hidden input", () => assert.equal(classifyField(d({ type: "hidden" })), "hidden"));
test("checkbox is consent", () => assert.equal(classifyField(d({ type: "checkbox" })), "consent"));
test("select is unknown", () => assert.equal(classifyField(d({ tag: "select" })), "unknown"));
test("unrecognized text input is unknown", () => assert.equal(classifyField(d({ name: "favcolor" })), "unknown"));

test("common fields from real forms", () => {
  const cases = [
    ["First Name:", "text", "firstName"],
    ["Last name:", "text", "lastName"],
    ["Email Address:", "text", "email"],
    ["Job Title:", "text", "jobTitle"],
    ["Company Name:", "text", "company"],
    ["Phone No.:", "text", "phone"],
    ["Subject:", "text", "subject"],
    ["Address:", "text", "address"],
  ];
  for (const [label, type, role] of cases) {
    assert.equal(classifyField(d({ label, type })), role, label);
  }
});
test("country dropdown is country, other dropdowns stay unknown", () => {
  assert.equal(classifyField(d({ tag: "select", label: "Country:" })), "country");
  assert.equal(classifyField(d({ tag: "select", label: "Civilité" })), "unknown");
});
test("Address textarea is address, not message", () => {
  assert.equal(classifyField(d({ tag: "textarea", label: "Address:" })), "address");
});
test("CAPTCHA response and honeypot fields are hidden", () => {
  assert.equal(classifyField(d({ tag: "textarea", name: "g-recaptcha-response" })), "hidden");
  assert.equal(classifyField(d({ tag: "textarea", name: "ak_hp_textarea" })), "hidden");
});
