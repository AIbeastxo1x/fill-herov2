// Score a form descriptor for auto-submit eligibility, and detect CAPTCHAs.
import { classifyField } from "./fieldMap.js";

export function scoreForm(form) {
  const fieldMap = {};
  const roles = form.fields.map((f) => classifyField(f));
  roles.forEach((role, i) => {
    if (fieldMap[role] === undefined) fieldMap[role] = i;
  });

  const result = (level, reason) => ({ level, reason, fieldMap });

  if (form.hasPassword) return result("low", "has-password");
  if (fieldMap.message === undefined) return result("low", "no-message-field");
  if (fieldMap.email === undefined) return result("low", "no-email-field");

  const consentRequired = form.fields.some((f, i) => roles[i] === "consent" && f.required);
  if (consentRequired) return result("low", "consent-required");

  const unmappedRequired = form.fields.some((f, i) => f.required && roles[i] === "unknown");
  if (unmappedRequired) return result("low", "unmapped-required");

  return result("high", "ok");
}

const CAPTCHA_PATTERN = /recaptcha|hcaptcha|turnstile/i;

export function detectCaptcha({ iframeSrcs = [], classNames = [] }) {
  return [...iframeSrcs, ...classNames].some((s) => CAPTCHA_PATTERN.test(s));
}
