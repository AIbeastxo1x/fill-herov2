// Front end for the Fill Hero server. Signs in with a password and calls /api on this same site.
// The Netlify functions hold the server token, so nothing secret is stored or sent from the browser.
const $ = (id) => document.getElementById(id);
const PROFILE_KEYS = ["firstName", "lastName", "company", "email", "phone", "subject", "jobTitle", "country", "address", "city", "state", "zip", "template"];
const SIGNED_OUT = "Signed out";

let timer = null;

async function api(route, { method = "GET", body } = {}) {
  const res = await fetch(`/api${route}`, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    signedOut("Your sign-in has expired. Sign in again.");
    throw new Error(SIGNED_OUT);
  }
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
    const s = await (await api("/state")).json();
    renderState(s);
    fillProfile(s.profile);
    setStatus("Connected", true);
  } catch (err) {
    if (err.message !== SIGNED_OUT) setStatus(`Error: ${err.message}`, false);
  }
}

// ---------- sign in / out ----------

function signedOut(message = "") {
  clearInterval(timer);
  timer = null;
  showCards(false);
  $("login-card").hidden = false;
  $("logout").hidden = true;
  setStatus("Signed out", false);
  $("login-msg").textContent = message;
}

async function signedIn() {
  $("login-card").hidden = true;
  $("logout").hidden = false;
  showCards(true);
  await refresh();
  clearInterval(timer);
  timer = setInterval(refresh, 3000);
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = $("password").value;
  if (!password) return;
  $("login").disabled = true;
  $("login-msg").textContent = "Signing in…";
  try {
    const res = await fetch("/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      $("login-msg").textContent = res.status === 401 ? "Wrong password." : "Could not sign in. Try again.";
      return;
    }
    $("password").value = "";
    $("login-msg").textContent = "";
    await signedIn();
  } catch {
    $("login-msg").textContent = "Could not reach the site. Check your connection.";
  } finally {
    $("login").disabled = false;
  }
});

$("logout").addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  signedOut("You have signed out.");
});

// ---------- profile ----------

$("save-profile").addEventListener("click", async () => {
  const profile = {};
  for (const key of PROFILE_KEYS) profile[key] = $(`p-${key}`).value;
  try {
    await api("/profile", { method: "PUT", body: profile });
    $("profile-msg").textContent = "Saved.";
  } catch (err) {
    if (err.message !== SIGNED_OUT) $("profile-msg").textContent = `Not saved: ${err.message}`;
  }
});

// ---------- run ----------

$("start").addEventListener("click", async () => {
  const domains = $("domains").value;
  if (!domains.trim()) return;
  const dryRun = $("dryrun").checked;
  if (!dryRun && !confirm("This is a LIVE run. Real messages will be submitted to these sites. Continue?")) return;
  try {
    await api("/start", { method: "POST", body: { domains, dryRun } });
    await refresh();
  } catch (err) {
    if (err.message !== SIGNED_OUT) alert(err.message === "already-running" ? "A run is already in progress." : `Could not start: ${err.message}`);
  }
});

$("stop").addEventListener("click", async () => {
  await api("/stop", { method: "POST" }).catch(() => {});
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

$("dl-emails").addEventListener("click", () => download("/files/emails.txt", "extractedemails.txt").catch((e) => { if (e.message !== SIGNED_OUT) alert(e.message); }));
$("dl-captcha").addEventListener("click", () => download("/files/captcha_domains.txt", "captcha_domains.txt").catch((e) => { if (e.message !== SIGNED_OUT) alert(e.message); }));

// ---------- reset ----------

$("clear-all").addEventListener("click", async () => {
  if (!confirm("Clear the report counts, queue, extracted emails and CAPTCHA list?\n\nYour profile and the list of domains already sent to are kept.")) return;
  try {
    await api("/clear", { method: "POST" });
  } catch (err) {
    if (err.message !== SIGNED_OUT) alert(err.message === "stop-the-run-first" ? "Stop the run first." : `Not cleared: ${err.message}`);
  }
  refresh();
});

// ---------- start ----------

(async () => {
  try {
    const res = await fetch("/auth/check", { credentials: "same-origin" });
    if (res.ok) await signedIn();
    else signedOut();
  } catch {
    signedOut("Could not reach the site. Check your connection.");
  }
})();
