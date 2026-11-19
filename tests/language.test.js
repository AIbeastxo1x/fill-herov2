import { test } from "node:test";
import assert from "node:assert/strict";
import { siteLanguage, needsTranslation } from "../src/lib/language.js";
import { classifyField } from "../src/lib/fieldMap.js";

const d = (o) => ({ tag: "input", type: "text", name: "", id: "", placeholder: "", autocomplete: "", label: "", required: false, ...o });

test("reads the base language from html lang", () => {
  assert.equal(siteLanguage("fr-FR"), "fr");
  assert.equal(siteLanguage("de"), "de");
  assert.equal(siteLanguage(""), null);
  assert.equal(siteLanguage(undefined), null);
});

test("translates only non-English pages", () => {
  assert.equal(needsTranslation("fr"), true);
  assert.equal(needsTranslation("en"), false);
  assert.equal(needsTranslation(null), false);
});

test("German labels", () => {
  assert.equal(classifyField(d({ label: "Vorname" })), "firstName");
  assert.equal(classifyField(d({ label: "Nachname" })), "lastName");
  assert.equal(classifyField(d({ label: "Firma" })), "company");
  assert.equal(classifyField(d({ label: "Betreff" })), "subject");
  assert.equal(classifyField(d({ label: "Nachricht" })), "message");
});

test("Spanish labels", () => {
  assert.equal(classifyField(d({ label: "Nombre" })), "firstName");
  assert.equal(classifyField(d({ label: "Apellido" })), "lastName");
  assert.equal(classifyField(d({ label: "Nombre completo" })), "name");
  assert.equal(classifyField(d({ label: "Mensaje" })), "message");
});

test("Italian labels, including cognome not read as nome", () => {
  assert.equal(classifyField(d({ label: "Cognome" })), "lastName");
  assert.equal(classifyField(d({ label: "Nome" })), "firstName");
  assert.equal(classifyField(d({ label: "Messaggio" })), "message");
});

test("English e-mail label written with a hyphen as plain text", () => {
  assert.equal(classifyField(d({ label: "E-mail" })), "email");
});
