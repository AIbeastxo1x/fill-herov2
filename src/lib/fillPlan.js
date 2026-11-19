// Decide what to fill in a contact form, and report what could not be filled and why.
import { scoreForm } from "./score.js";

// Platform signals in the form's id, class or action. Used for the log and for
// spotting templates; filling itself is driven by each field's label, name and type.
const PLATFORM_HINTS = [
  ["contact-form-7", /wpcf7/i],
  ["gravity-forms", /gform/i],
  ["hubspot", /hbspt|hs-form/i],
  ["wix", /\bwix\b|\bcomp-/i],
  ["webflow", /w-form/i],
  ["squarespace", /squarespace/i],
];

export function detectPlatform(form) {
  const hay = `${form.id || ""} ${form.className || ""} ${form.action || ""}`;
  const hit = PLATFORM_HINTS.find(([, re]) => re.test(hay));
  return hit ? hit[0] : "generic";
}

// "contact": has a name field, an email field and a message field.
// "message-only": email and message, no name field.
// "other": anything else that still passed scoring.
export function detectFormType(scored) {
  const m = scored.fieldMap;
  const hasName = m.firstName !== undefined || m.lastName !== undefined || m.name !== undefined;
  if (m.message !== undefined && m.email !== undefined) return hasName ? "contact" : "message-only";
  return "other";
}

export function valuesFor(profile, host) {
  const first = profile.firstName || "";
  const last = profile.lastName || "";
  return {
    firstName: first,
    lastName: last,
    name: [first, last].filter(Boolean).join(" "),
    email: profile.email || "",
    phone: profile.phone || "",
    company: profile.company || "",
    subject: profile.subject || "",
    jobTitle: profile.jobTitle || "",
    country: profile.country || "",
    address: profile.address || "",
    zip: profile.zip || "",
    city: profile.city || "",
    state: profile.state || "",
    message: (profile.template || "").replaceAll("{domain}", host).replaceAll("{company}", profile.company || ""),
  };
}

// Returns the score, the form type, the platform, the fills to apply, and
// the fields that have a role but no value to fill them with.
export function buildFillPlan(form, profile, host) {
  const score = scoreForm(form);
  const values = valuesFor(profile, host);
  const fills = [];
  const unfilled = [];

  for (const [role, index] of Object.entries(score.fieldMap)) {
    if (!(role in values)) continue; // hidden, submit, consent, unknown
    const value = values[role];
    if (value) fills.push({ index, role, value });
    else unfilled.push({ index, role, reason: "profile-empty", required: !!form.fields[index]?.required });
  }

  return {
    score,
    type: detectFormType(score),
    platform: detectPlatform(form),
    fills,
    unfilled,
  };
}

// Short human-readable summary for the log. "filled" lists only the fields that are
// actually holding a value on the page, so the log cannot claim a fill that did not happen.
export function summarizePlan(plan, applied) {
  const failed = applied && applied.ok === false && applied.reason ? applied.reason : null;
  const bad = new Set([...(applied?.missing ?? []), ...(applied?.unverified ?? [])]);
  const landed = failed ? [] : plan.fills.filter((f) => !bad.has(f.index)).map((f) => f.role);
  const notHolding = plan.fills.filter((f) => bad.has(f.index)).map((f) => f.role);

  const parts = [`type=${plan.type}`, `platform=${plan.platform}`, `filled=${landed.join(",") || "none"}`];
  if (failed) parts.push(`fill-failed=${failed}`);
  if (notHolding.length) parts.push(`not-holding=${notHolding.join(",")}`);
  if (applied && applied.reapplied) parts.push(`reapplied=${applied.reapplied}`);
  if (plan.unfilled.length) {
    parts.push(`unfilled=${plan.unfilled.map((u) => `${u.role}${u.required ? "(required)" : ""}`).join(",")}`);
  }
  return parts.join("; ");
}
