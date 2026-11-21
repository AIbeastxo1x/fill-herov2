// Control panel. Talks to background.js via chrome.runtime messages.
const $ = (id) => document.getElementById(id);

const PROFILE_FIELDS = {
  "p-first": "firstName",
  "p-last": "lastName",
  "p-company": "company",
  "p-email": "email",
  "p-phone": "phone",
  "p-subject": "subject",
  "p-job": "jobTitle",
  "p-country": "country",
  "p-address": "address",
  "p-city": "city",
  "p-state": "state",
  "p-zip": "zip",
  "p-template": "template",
};
const DEFAULT_TEMPLATE = "Hello {domain} team,\n\n";
const DAILY_CAP = 5000; // keep in step with LIMITS.dailyCap in background.js

function readProfile() {
  const p = {};
  for (const [id, key] of Object.entries(PROFILE_FIELDS)) p[key] = $(id).value;
  return p;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Returns the background's reply, or null if it did not answer (for example, while it restarts).
async function send(msg) {
  return chrome.runtime.sendMessage(msg).catch(() => null);
}

let dryRunLoaded = false; // the dry-run box is read from storage once; after that only the user changes it

function render(state) {
  $("running").textContent = state.running ? "Running…" : "";
  if (!dryRunLoaded) {
    $("dryrun").checked = !!state.dryRun;
    dryRunLoaded = true;
  }

  for (const [id, key] of Object.entries(PROFILE_FIELDS)) {
    if (document.activeElement !== $(id)) $(id).value = state.profile[key] ?? (key === "template" ? DEFAULT_TEMPLATE : "");
  }

  const counts = {};
  for (const e of state.log) counts[e.status] = (counts[e.status] ?? 0) + 1;
  const rows = [
    ["Sent", (counts.sent ?? 0) + (counts["sent?"] ?? 0)],
    ["Filled for review", counts["filled-for-review"] ?? 0],
    ["Queued", counts.queued ?? 0],
    ["Skipped", counts.skipped ?? 0],
    ["Failed", counts.failed ?? 0],
    ["Total entries", state.log.length],
  ];
  $("summary").innerHTML = rows.map(([label, n]) => `<tr><td>${esc(label)}</td><td class="num">${n}</td></tr>`).join("");
  $("cap").textContent = `Sent today: ${state.dailyDate === localDate() ? state.dailyCount : 0} of ${DAILY_CAP}.`;
  $("email-count").textContent = new Set(state.emails.map((e) => e.email)).size;
  $("captcha-count").textContent = state.captchaDomains.length;
  $("sent-count").textContent = state.sentHosts.length;

}

function localDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function refresh() {
  const state = await send({ type: "state" });
  if (state) render(state);
}

$("start").addEventListener("click", async () => {
  const domains = $("domains").value;
  if (!domains.trim()) return;
  const res = await send({ type: "start", domains, dryRun: $("dryrun").checked, profile: readProfile() });
  if (!res) alert("The extension did not respond. Reload it in chrome://extensions and try again.");
  else if (!res.ok) alert("Already running.");
  refresh();
});

$("stop").addEventListener("click", async () => {
  await send({ type: "stop" });
  refresh();
});

$("export-emails").addEventListener("click", () => send({ type: "exportEmailsCsv" }));
$("save-emails").addEventListener("click", async () => {
  const res = await send({ type: "saveEmailsFile" });
  if (!res?.ok) alert("Could not save extractedemails.txt.");
});
$("save-captcha").addEventListener("click", async () => {
  const res = await send({ type: "saveCaptchaFile" });
  if (!res?.ok) alert("Could not save captcha_domains.txt.");
});
$("clear-all").addEventListener("click", async () => {
  if (!confirm("Clear the log, review queue, extracted emails and CAPTCHA list?\n\nYour profile, domains and sent-domain record are kept.")) return;
  const res = await send({ type: "clearAll" });
  if (res && !res.ok) alert("Stop the run first.");
  refresh();
});

$("dryrun").addEventListener("change", () => chrome.storage.local.set({ dryRun: $("dryrun").checked }));

$("csv").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $("domains").value = await file.text();
});

for (const id of Object.keys(PROFILE_FIELDS)) {
  $(id).addEventListener("change", async () => {
    await chrome.storage.local.set({ profile: readProfile() });
  });
}

refresh();
setInterval(refresh, 2000);
