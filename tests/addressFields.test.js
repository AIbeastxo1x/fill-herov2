import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyField } from "../src/lib/fieldMap.js";
import { valuesFor } from "../src/lib/fillPlan.js";

const input = (label, extra = {}) => ({ tag: "input", type: "text", label, ...extra });

test("zip and postal code labels are classified as zip", () => {
  assert.equal(classifyField(input("ZIP Code")), "zip");
  assert.equal(classifyField(input("Postal code")), "zip");
  assert.equal(classifyField(input("", { name: "postcode" })), "zip");
  assert.equal(classifyField(input("Code postal")), "zip");
});

test("city and town labels are classified as city", () => {
  assert.equal(classifyField(input("City")), "city");
  assert.equal(classifyField(input("", { name: "town" })), "city");
  assert.equal(classifyField(input("Ville")), "city");
});

test("state and province labels are classified as state", () => {
  assert.equal(classifyField(input("State / Province")), "state");
  assert.equal(classifyField(input("", { id: "province" })), "state");
  assert.equal(classifyField(input("Région")), "state");
});

test("a full address label still wins over the address parts", () => {
  assert.equal(classifyField(input("Postal address")), "address");
  assert.equal(classifyField(input("Street address")), "address");
});

test("the address textarea and first-name fields are unaffected", () => {
  assert.equal(classifyField({ tag: "input", type: "text", label: "First name" }), "firstName");
  assert.equal(classifyField({ tag: "textarea", label: "Message" }), "message");
});

test("valuesFor supplies zip, city and state from the profile", () => {
  const v = valuesFor({ zip: "10115", city: "Berlin", state: "Berlin" }, "example.de");
  assert.equal(v.zip, "10115");
  assert.equal(v.city, "Berlin");
  assert.equal(v.state, "Berlin");
  assert.equal(valuesFor({}, "example.de").zip, "");
});
