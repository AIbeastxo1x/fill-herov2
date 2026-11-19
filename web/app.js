// Front end for the Fill Hero server. Talks to the API with a bearer token.
// The address and token are kept only in this browser (localStorage), and only if it allows storage.
const $ = (id) => document.getElementById(id);
const PROFILE_KEYS = ["firstName", "lastName", "company", "email", "phone", "subject", "jobTitle", "country", "address", "city", "state", "zip", "template"];
const KEY_BASE = "fillhero.apiBase";
const KEY_TOKEN = "fillhero.token";

let apiBase = "";
let token = "";
let timer = null;

function readStore(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return ""; // private window or blocked storage: the page still works, but asks again
  }
}
function writeStore(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore: nothing to do when storage is blocked */
  }
}

async function api(route, { method = "GET", body } = {}) {
  const res = await fetch(apiBase + route, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res;
}

function setStatus(text, ok) {
  const pill = $("status");
  pill.textContent = text;
  pill.classList.toggle("ok", !!ok);
}

function showCards(visible) {
  for (const id of ["run-card", "report-card", "profile-card", "files-card", "reset-card"]) $(id).hidden = !visible;
}

function fillProfile(profile) {
  for (const key of PROFILE_KEYS) {
    const el = $(`p-${key}`);
    if (document.activeElement !== el) el.value = profile[key] ?? "";
  }
}

function renderState(s) {
  $("running").textContent = s.running ? "Running…" : "";
  $("stop").disabled = !s.running;
  $("start").disabled = s.running;
  $("dryrun").checked = !!s.dryRun;
  $("run-help").textContent = s.dryRun
    ? "Dry run is on: forms are filled and checked, nothing is submitted."
    : "Live run: real messages will be submitted. Check the dry run first.";

  const sm = s.summary;
  const rows = [
    ["Sent", sm.sent],
    ["Filled for review", sm.filledForReview],
    ["Queued", sm.queued],
    ["Skipped", sm.skipped],
    ["Failed", sm.failed],
    ["Total entries", sm.totalEntries],
  ];
  $("summary").innerHTML = rows.map(([label, n]) => `<tr><td>${label}</td><td class="num">${n}</td></tr>`).join("");
  $("cap").textContent = `Sent today: ${s.dailyCount} of ${s.dailyCap}. Gap between submissions: ${s.gapSeconds} seconds.`;

  $("email-count").textContent = s.emailCount;
  $("captcha-count").textContent = s.captchaCount;
  $("sent-count").textContent = s.sentDomains;
}

async function refresh() {
  try {
    const s = await (await api("/api/state")).json();
    renderState(s);
    fillProfile(s.profile);
    setStatus("Connected", true);
  } catch (err) {
    setStatus(`Error: ${err.message}`, false);
  }
}

function startPolling() {
  clearInterval(timer);
  timer = setInterval(refresh, 3000);
}

// ---------- connection ----------

$("connect").addEventListener("click", async () => {
  apiBase = $("api-base").value.trim().replace(/\/+$/, "");
  token = $("token").value.trim();
  if (!apiBase || !token) {
    $("connect-msg").textContent = "Enter the server address and token.";
    return;
  }
  $("connect-msg").textContent = "Connecting…";
  try {
    await api("/api/state");
    writeStore(KEY_BASE, apiBase);
    writeStore(KEY_TOKEN, token);
    $("connect-msg").textContent = "";
    showCards(true);
    await refresh();
    startPolling();
  } catch (err) {
    showCards(false);
    setStatus("Not connected", false);
    $("connect-msg").textContent = err.message === "unauthorized" ? "The token is not accepted." : `Could not connect: ${err.message}`;
  }
});

// ---------- profile ----------

$("save-profile").addEventListener("click", async () => {
  const profile = {};
  for (const key of PROFILE_KEYS) profile[key] = $(`p-${key}`).value;
  try {
    await api("/api/profile", { method: "PUT", body: profile });
    $("profile-msg").textContent = "Saved.";
  } catch (err) {
    $("profile-msg").textContent = `Not saved: ${err.message}`;
  }
});

// ---------- run ----------

$("start").addEventListener("click", async () => {
  const domains = $("domains").value;
  if (!domains.trim()) return;
  const dryRun = $("dryrun").checked;
  if (!dryRun && !confirm("This is a LIVE run. Real messages will be submitted to these sites. Continue?")) return;
  try {
    await api("/api/start", { method: "POST", body: { domains, dryRun } });
    await refresh();
  } catch (err) {
    alert(err.message === "already-running" ? "A run is already in progress." : `Could not start: ${err.message}`);
  }
});

$("stop").addEventListener("click", async () => {
  await api("/api/stop", { method: "POST" }).catch(() => {});
  refresh();
});

$("dryrun").addEventListener("change", () => {
  // The next run uses whichever box is ticked when Start is pressed.
  $("run-help").textContent = $("dryrun").checked
    ? "Dry run is on: forms are filled and checked, nothing is submitted."
    : "Live run: real messages will be submitted. Check the dry run first.";
});

// ---------- files ----------

async function download(route, filename) {
  const res = await api(route);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("dl-emails").addEventListener("click", () => download("/api/files/emails.txt", "extractedemails.txt").catch((e) => alert(e.message)));
$("dl-captcha").addEventListener("click", () => download("/api/files/captcha_domains.txt", "captcha_domains.txt").catch((e) => alert(e.message)));

// ---------- reset ----------

$("clear-all").addEventListener("click", async () => {
  if (!confirm("Clear the report counts, queue, extracted emails and CAPTCHA list?\n\nYour profile and the list of domains already sent to are kept.")) return;
  try {
    await api("/api/clear", { method: "POST" });
  } catch (err) {
    alert(err.message === "stop-the-run-first" ? "Stop the run first." : `Not cleared: ${err.message}`);
  }
  refresh();
});

// ---------- start ----------

apiBase = readStore(KEY_BASE) || window.FILLHERO_API_BASE || "";
token = readStore(KEY_TOKEN);
$("api-base").value = apiBase;
$("token").value = token;
if (apiBase && token) $("connect").click();
