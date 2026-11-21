// Front end for the Fill Hero server. Signs in with a password and calls /api on this same site.
// The Netlify functions hold the server token, so nothing secret is stored or sent from the browser.
const $ = (id) => document.getElementById(id);
const PROFILE_KEYS = ["firstName", "lastName", "company", "email", "phone", "subject", "jobTitle", "country", "address", "city", "state", "zip", "template"];
const SIGNED_OUT = "Signed out";

let timer = null;
let dryRunLoaded = false; // the dry-run box is set from the server once, then only the user changes it

// Fields the user has typed in and not saved yet. The 3-second refresh must not overwrite them.
const edited = new Set();
document.addEventListener("input", (e) => { if (e.target.id) edited.add(e.target.id); });
document.addEventListener("change", (e) => { if (e.target.id) edited.add(e.target.id); });
function setField(id, value) {
  if (!edited.has(id)) $(id).value = value;
}
function markSaved(...ids) {
  for (const id of ids) edited.delete(id);
}
function updateRunHelp() {
  $("run-help").textContent = $("dryrun").checked
    ? "Dry run is on: forms are filled and checked, nothing is submitted."
    : "Live run: real messages will be submitted. Check the dry run first.";
}

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
  for (const id of ["run-card", "live-card", "report-card", "profile-card", "files-card", "smtp-card", "licences-card", "contacts-card", "campaign-card", "reset-card"]) $(id).hidden = !visible;
}

function fillProfile(profile) {
  for (const key of PROFILE_KEYS) setField(`p-${key}`, profile[key] ?? "");
}

function renderState(s) {
  $("running").textContent = s.running ? "Running…" : "";
  $("stop").disabled = !s.running;
  $("start").disabled = s.running;
  if (!dryRunLoaded) {
    $("dryrun").checked = !!s.dryRun;
    dryRunLoaded = true;
    updateRunHelp();
  }

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
    return;
  }
  await refreshLive();
  await refreshLicences();
  await refreshCampaign();
  await refreshSmtp();
  await refreshContacts();
}

// ---------- extension licences ----------

async function refreshLicences() {
  try {
    const d = await (await api("/licences")).json();
    const body = $("l-list");
    body.replaceChildren(
      ...(d.licences.length
        ? d.licences.map((l) => {
            const tr = document.createElement("tr");
            const who = document.createElement("td");
            who.textContent = l.customer;
            const status = document.createElement("td");
            status.className = "num";
            status.textContent = l.status === "active" ? `issued ${l.issuedAt ? new Date(l.issuedAt).toLocaleDateString() : ""}` : "revoked";
            const action = document.createElement("td");
            action.className = "num";
            if (l.status === "active") {
              const btn = document.createElement("button");
              btn.className = "danger";
              btn.textContent = "Revoke";
              btn.addEventListener("click", () => revokeLicence(l.id, l.customer));
              action.append(btn);
            }
            tr.append(who, status, action);
            return tr;
          })
        : [Object.assign(document.createElement("tr"), { innerHTML: "<td>No licences issued yet.</td>" })])
    );
  } catch (err) {
    if (err.message !== SIGNED_OUT) $("l-msg").textContent = `Could not load licences: ${err.message}`;
  }
}

async function revokeLicence(id, customer) {
  if (!confirm(`Revoke the licence for ${customer}? They will be stopped at their next check.`)) return;
  try {
    await api(`/licences/${id}/revoke`, { method: "POST" });
    $("l-msg").textContent = `Revoked the licence for ${customer}.`;
  } catch (err) {
    if (err.message !== SIGNED_OUT) $("l-msg").textContent = `Not revoked: ${err.message}`;
  }
  refreshLicences();
}

$("issue-licence").addEventListener("click", async () => {
  const customer = $("l-customer").value.trim();
  if (!customer) {
    $("l-msg").textContent = "Enter who the licence is for.";
    return;
  }
  try {
    const r = await api("/licences", { method: "POST", body: { customer } });
    const d = await r.json();
    $("l-key").textContent = d.key;
    $("l-new").hidden = false;
    $("l-customer").value = "";
    $("l-msg").textContent = `Issued to ${d.customer}.`;
  } catch (err) {
    if (err.message !== SIGNED_OUT) $("l-msg").textContent = `Not issued: ${err.message}`;
  }
  refreshLicences();
});

// ---------- live view ----------

let lastStepCount = -1;

async function refreshLive() {
  try {
    const d = await (await api("/live")).json();
    if (d.stepCount === lastStepCount) return; // nothing new since the last check
    lastStepCount = d.stepCount;

    const list = $("live-steps");
    list.replaceChildren(
      ...d.steps.map((s) => {
        const li = document.createElement("li");
        const time = document.createElement("span");
        time.className = "time";
        time.textContent = new Date(s.at).toLocaleTimeString();
        li.append(time);
        if (s.host) {
          const host = document.createElement("span");
          host.className = "host";
          host.textContent = s.host;
          li.append(host);
        }
        li.append(document.createTextNode(s.text));
        return li;
      })
    );
    if (d.steps.length === 0) {
      const li = document.createElement("li");
      li.textContent = "No steps yet.";
      list.append(li);
    }
    list.scrollTop = list.scrollHeight;

    const img = $("live-img");
    if (d.image) {
      img.src = `data:image/jpeg;base64,${d.image}`;
      img.hidden = false;
      $("live-empty").hidden = true;
    }
  } catch (err) {
    if (err.message !== SIGNED_OUT) $("live-empty").textContent = `Could not load the live view: ${err.message}`;
  }
}

// ---------- consented contacts ----------

async function refreshContacts() {
  try {
    const c = await (await api("/contacts")).json();
    const sources = c.bySource.map((s) => `${s.source}: ${s.count}`).join("; ");
    $("contacts-summary").textContent = c.count
      ? `${c.count} consented contacts. ${sources}.`
      : "No contacts yet.";
  } catch (err) {
    if (err.message !== SIGNED_OUT) $("contacts-msg").textContent = `Could not load contacts: ${err.message}`;
  }
}

$("k-date").value = new Date().toISOString().slice(0, 10);

$("import-contacts").addEventListener("click", async () => {
  const text = $("k-list").value;
  const consentSource = $("k-source").value.trim();
  const consentDate = $("k-date").value;
  if (!text.trim()) return;
  if (!consentSource) {
    $("contacts-msg").textContent = "Say where these people agreed to be contacted.";
    return;
  }
  try {
    const r = await api("/contacts/import", { method: "POST", body: { text, consentSource, consentDate } });
    const d = await r.json();
    const parts = [`Added ${d.added}`];
    if (d.duplicates) parts.push(`${d.duplicates} already on the list`);
    if (d.onDoNotEmailList) parts.push(`${d.onDoNotEmailList} on the do-not-email list`);
    if (d.invalid) parts.push(`${d.invalid} lines not valid emails: ${d.invalidLines.join(" | ")}`);
    $("contacts-msg").textContent = parts.join(". ") + ".";
    if (d.added) $("k-list").value = "";
  } catch (err) {
    if (err.message !== SIGNED_OUT) $("contacts-msg").textContent = `Not imported: ${err.message}`;
  }
  refreshContacts();
  refreshCampaign();
});

$("clear-contacts").addEventListener("click", async () => {
  if (!confirm("Remove every contact from the campaign list? The send record and do-not-email list are kept.")) return;
  try {
    await api("/contacts/clear", { method: "POST" });
    $("contacts-msg").textContent = "Contact list cleared.";
  } catch (err) {
    if (err.message !== SIGNED_OUT) $("contacts-msg").textContent = `Not cleared: ${err.message}`;
  }
  refreshContacts();
  refreshCampaign();
});

// ---------- email campaign ----------

async function refreshCampaign() {
  try {
    const c = await (await api("/campaign")).json();
    setField("c-subject", c.campaign.subject);
    setField("c-body", c.campaign.body);
    let cfg = c.configured
      ? `Relay connected. At most ${c.dailyCap} emails a day, ${c.gapSeconds} seconds apart.`
      : "No email relay is set up on the server yet, so only dry runs are possible.";
    if (!c.unsubscribeReady) cfg += " Unsubscribe links are not set up: the server needs PUBLIC_BASE_URL.";
    $("campaign-config").textContent = cfg;
    $("campaign-running").textContent = c.running ? "Sending…" : "";
    $("campaign-start").disabled = c.running;
    $("campaign-stop").disabled = !c.running;
    $("c-recipients").textContent = c.recipients;
    $("c-sent").textContent = c.sent;
    $("c-failed").textContent = c.failed;
    $("c-suppressed").textContent = c.suppressed;
  } catch (err) {
    if (err.message !== SIGNED_OUT) $("campaign-help").textContent = `Could not load the campaign: ${err.message}`;
  }
}

// ---------- relay settings ----------

function renderSmtp(s) {
  setField("s-host", s.host);
  setField("s-port", s.port);
  setField("s-user", s.user);
  setField("s-from", s.from);
  $("smtp-source").textContent = s.configured
    ? `Connected to ${s.host} (settings from ${s.source === "settings" ? "this page" : "the server's environment"}).`
    : "Not set up yet. Enter the relay details below and save.";
  $("s-pass-help").textContent = s.passwordSaved
    ? "A password is saved. It is never shown. Type a new one to replace it."
    : "No password saved.";
}

async function refreshSmtp() {
  try {
    renderSmtp(await (await api("/smtp")).json());
  } catch (err) {
    if (err.message !== SIGNED_OUT) $("smtp-msg").textContent = `Could not load relay settings: ${err.message}`;
  }
}

function smtpPayload(extra = {}) {
  return {
    host: $("s-host").value,
    port: Number($("s-port").value || 587),
    user: $("s-user").value,
    from: $("s-from").value,
    ...extra,
  };
}

$("save-smtp").addEventListener("click", async () => {
  $("smtp-msg").textContent = "Saving…";
  try {
    const r = await api("/smtp", { method: "PUT", body: smtpPayload({ password: $("s-pass").value }) });
    markSaved("s-host", "s-port", "s-user", "s-from");
    renderSmtp(await r.json());
    $("s-pass").value = "";
    $("smtp-msg").textContent = "Saved.";
  } catch (err) {
    if (err.message !== SIGNED_OUT) $("smtp-msg").textContent = `Not saved: ${err.message}`;
  }
  refreshCampaign();
});

$("clear-pass").addEventListener("click", async () => {
  if (!confirm("Remove the saved relay password? Live sending will stop until a password is saved again.")) return;
  try {
    const r = await api("/smtp", { method: "PUT", body: smtpPayload({ clearPassword: true }) });
    markSaved("s-host", "s-port", "s-user", "s-from");
    renderSmtp(await r.json());
    $("smtp-msg").textContent = "Saved password removed.";
  } catch (err) {
    if (err.message !== SIGNED_OUT) $("smtp-msg").textContent = `Not removed: ${err.message}`;
  }
  refreshCampaign();
});

$("test-smtp").addEventListener("click", async () => {
  $("smtp-msg").textContent = "Sending test…";
  try {
    const r = await api("/smtp/test", { method: "POST" });
    const data = await r.json();
    $("smtp-msg").textContent = `Test sent to ${data.to}. Check that inbox.`;
  } catch (err) {
    if (err.message !== SIGNED_OUT) $("smtp-msg").textContent = `Test failed: ${err.message}`;
  }
});

$("save-campaign").addEventListener("click", async () => {
  try {
    await api("/campaign", { method: "PUT", body: { subject: $("c-subject").value, body: $("c-body").value } });
    markSaved("c-subject", "c-body");
    $("campaign-msg").textContent = "Saved.";
  } catch (err) {
    if (err.message !== SIGNED_OUT) $("campaign-msg").textContent = `Not saved: ${err.message}`;
  }
});

$("campaign-start").addEventListener("click", async () => {
  const dryRun = $("c-dryrun").checked;
  const count = Number($("c-recipients").textContent) || 0;
  if (!dryRun && !confirm(`This will send a real email to up to ${count} addresses, one at a time, with the gap and daily cap set on the server. Only continue if these recipients have agreed to be contacted. Continue?`)) return;
  try {
    const r = await api("/campaign/start", { method: "POST", body: { dryRun } });
    const data = await r.json();
    $("campaign-help").textContent = data.dryRun ? `Dry run started for ${data.recipients} addresses. Nothing is sent.` : `Live campaign started for ${data.recipients} addresses.`;
  } catch (err) {
    if (err.message !== SIGNED_OUT) alert(`Could not start: ${err.message}`);
  }
  refreshCampaign();
});

$("campaign-stop").addEventListener("click", async () => {
  await api("/campaign/stop", { method: "POST" }).catch(() => {});
  refreshCampaign();
});

$("add-suppress").addEventListener("click", async () => {
  const emails = $("c-suppress").value;
  if (!emails.trim()) return;
  try {
    const r = await api("/campaign/suppress", { method: "POST", body: { emails } });
    const data = await r.json();
    $("suppress-msg").textContent = `Saved. ${data.suppressed} addresses on the list.`;
    $("c-suppress").value = "";
  } catch (err) {
    if (err.message !== SIGNED_OUT) $("suppress-msg").textContent = `Not saved: ${err.message}`;
  }
  refreshCampaign();
});

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
  dryRunLoaded = false; // read the server's dry-run setting again after signing in
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
    markSaved(...PROFILE_KEYS.map((k) => `p-${k}`));
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

$("dryrun").addEventListener("change", updateRunHelp); // the next run uses whichever box is ticked when Start is pressed

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
