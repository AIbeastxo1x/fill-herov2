// Service worker: orchestrates tabs, scoring, translation, rate limits, the queue and the log.
import { parseDomainList } from "./lib/normalize.js";
import { findContactLinks } from "./lib/contactLinks.js";
import { scoreForm } from "./lib/score.js";
import { canSubmit, nextState } from "./lib/rateLimit.js";
import { addLog, hasSent } from "./lib/queue.js";
import { buildFillPlan, summarizePlan } from "./lib/fillPlan.js";
import { siteLanguage, needsTranslation } from "./lib/language.js";
import { extractEmails, emailsToCsv } from "./lib/emails.js";
import { buildEmailsFile, buildCaptchaFile, dataUrl, EMAIL_FILE, CAPTCHA_FILE } from "./lib/files.js";
import { needsCheck, decide, GRACE_MS, isExpired, daysLeft } from "./lib/licence.js";

const LIMITS = { gapMs: 25000, dailyCap: 5000 };
const MAX_CONTACT_PAGES = 3;
const MAX_TABS = 5; // tabs kept open at once: up to this many domains in progress, plus idle tabs (review, dry run)
const WORKERS = 5; // domains worked on at the same time, each in its own tab
// Time limits. Tests may override them through globalThis.__FILLHERO_TEST__; the defaults are used otherwise.
const CFG = {
  stepMs: 20000, // any single page step gives up after this
  translateMs: 60000, // the first on-device translation may download a model, so it gets longer
  submitMs: 60000, // submitting can be slow on some sites, so it gets longer than a scan or fill
  domainMs: 180000, // a whole domain gives up after this, so one bad site cannot stall a run
  historyEvery: 500, // domain visits between history clean-ups
  licenceUrl: "https://fill-herov2.onrender.com/licence/verify", // the server that checks licence keys
  ...(globalThis.__FILLHERO_TEST__ ?? {}),
};
const STEP_TIMEOUT_MS = CFG.stepMs;
const TRANSLATE_TIMEOUT_MS = CFG.translateMs;
const SUBMIT_TIMEOUT_MS = CFG.submitMs;
const DOMAIN_TIMEOUT_MS = CFG.domainMs;
const HISTORY_CLEAR_EVERY = CFG.historyEvery;
const DEFAULT_PROFILE = {
  firstName: "",
  lastName: "",
  company: "",
  email: "",
  phone: "",
  subject: "",
  jobTitle: "",
  country: "",
  address: "",
  city: "",
  state: "",
  zip: "",
  template: "Hello {domain} team,\n\n",
};

let running = false;
let stopRequested = false;
const activeTabs = new Set(); // tabs of the domains being worked on now, so Stop can close them

// Storage updates read, change and save the same data. Running them one at a time stops
// two domains working at once from overwriting each other's changes.
let storageChain = Promise.resolve();
function locked(fn) {
  const run = storageChain.then(fn);
  storageChain = run.catch(() => {});
  return run;
}

// ---------- storage ----------

async function getAll() {
  const keys = ["log", "queue", "emails", "captchaDomains", "sentHosts", "profile", "dailyCount", "dailyDate", "lastSubmitAt", "dryRun"];
  const s = await chrome.storage.local.get(keys);
  return {
    log: s.log ?? [],
    queue: s.queue ?? [],
    emails: s.emails ?? [],
    captchaDomains: s.captchaDomains ?? [],
    sentHosts: s.sentHosts ?? [], // hosts we have submitted to; kept by Clear all so they are never contacted again
    profile: { ...DEFAULT_PROFILE, ...(s.profile ?? {}) },
    dailyCount: s.dailyCount ?? 0,
    dailyDate: s.dailyDate ?? "",
    lastSubmitAt: s.lastSubmitAt ?? 0,
    dryRun: !!s.dryRun,
  };
}

const save = (obj) => chrome.storage.local.set(obj);

// The two functions below must run inside locked(); they never lock themselves.
async function appendLog(entry) {
  const { log } = await getAll();
  await save({ log: addLog(log, { ...entry, at: Date.now() }) });
}

const logEntry = (entry) => locked(() => appendLog(entry));

const queueEntry = (entry) =>
  locked(async () => {
    const { queue } = await getAll();
    await save({ queue: [...queue.filter((q) => q.host !== entry.host), { ...entry, at: Date.now() }] });
    await appendLog({ host: entry.host, status: "queued", reason: entry.reason, pageUrl: entry.pageUrl });
  });

// ---------- tab management ----------

// Tabs this extension opened, oldest first. A tab leaves the list when it is closed
// by us or by the user.
const managedTabs = [];

// Review tabs opened by Approve: tab id -> the address the review opened, or null until it has loaded.
const reviewTabs = new Map();

chrome.tabs.onRemoved.addListener((id) => {
  const i = managedTabs.indexOf(id);
  if (i >= 0) managedTabs.splice(i, 1);
  activeTabs.delete(id);
  reviewTabs.delete(id);
});

// A review tab is finished once its form is submitted and the page moves on. Close it a moment later.
chrome.tabs.onUpdated.addListener((id, info) => {
  const reviewedUrl = reviewTabs.get(id);
  if (!reviewedUrl || !info.url || info.url === reviewedUrl) return; // still loading, or not a loaded review tab
  setTimeout(() => closeReviewTab(id), 3000);
});

async function closeReviewTab(id) {
  reviewTabs.delete(id);
  await closeTab(id);
}

// Closes every review tab, for when the reviews are done.
async function closeReviewTabs() {
  for (const id of [...reviewTabs.keys()]) await closeReviewTab(id);
}

// Opens a tab. If MAX_TABS idle tabs are already open, closes the oldest idle one first.
// A tab in use by a domain being worked on is never closed here. busy: the tab is in use from the start.
async function openTab(url, active, busy = false) {
  for (;;) {
    const idle = managedTabs.filter((id) => !activeTabs.has(id));
    if (idle.length < MAX_TABS) break;
    await closeTab(idle[0]);
  }
  const tab = await chrome.tabs.create({ url, active });
  managedTabs.push(tab.id);
  if (busy) activeTabs.add(tab.id);
  return tab;
}

async function closeTab(id) {
  const i = managedTabs.indexOf(id);
  if (i >= 0) managedTabs.splice(i, 1);
  activeTabs.delete(id);
  await chrome.tabs.remove(id).catch(() => {});
}

// ---------- page helpers ----------

function waitForLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Rejects if the promise does not settle in time. The error text starts with "timed out".
function withTimeout(promise, ms, label) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}
const isTimeout = (err) => String(err?.message ?? err).startsWith("timed out");

// Like withTimeout, but the clock does not run while the domain waits for its turn to submit
// (token.waiting), since that wait is the rate limit, not a stuck site.
function withDeadline(promise, ms, label, token) {
  return new Promise((resolve, reject) => {
    let timer;
    const arm = (delay) => {
      timer = setTimeout(() => {
        if (token.waiting) return arm(5000);
        reject(new Error(`timed out: ${label}`));
      }, delay);
    };
    arm(ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// Attach the load listener before navigating, so a fast load cannot finish unseen.
async function go(tabId, url) {
  const loaded = waitForLoad(tabId);
  await chrome.tabs.update(tabId, { url });
  await loaded;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  await rememberVisit(url, tab?.url);
}

async function collectLinks(tabId) {
  const [res] = await withTimeout(
    chrome.scripting.executeScript({
      target: { tabId },
      func: () => Array.from(document.querySelectorAll("a[href]")).map((a) => ({ href: a.getAttribute("href"), text: a.textContent || "" })),
    }),
    STEP_TIMEOUT_MS,
    "read links"
  );
  return res?.result ?? [];
}

// The page's full source, used to find every email address on it.
async function pageHtml(tabId) {
  const [res] = await withTimeout(
    chrome.scripting.executeScript({
      target: { tabId },
      func: () => (document.documentElement ? document.documentElement.outerHTML : ""),
    }),
    STEP_TIMEOUT_MS,
    "read page"
  );
  return res?.result ?? "";
}

// Stores new addresses for a host. items: [{ email, pageUrl }]. Returns how many were new.
function storeEmails(host, items) {
  return locked(async () => {
    const { emails } = await getAll();
    const known = new Set(emails.filter((e) => e.host === host).map((e) => e.email));
    const at = Date.now();
    const fresh = items.filter((i) => !known.has(i.email)).map((i) => ({ host, email: i.email, pageUrl: i.pageUrl, at }));
    if (fresh.length) await save({ emails: [...emails, ...fresh] });
    return fresh.length;
  });
}

// Records a domain that stopped at a CAPTCHA. One row per domain; the newest visit wins.
function storeCaptchaDomain(host, pageUrl) {
  return locked(async () => {
    const { captchaDomains } = await getAll();
    await save({ captchaDomains: [...captchaDomains.filter((c) => c.host !== host), { host, pageUrl, at: Date.now() }] });
  });
}

// Saves a text file under Downloads/FillHero, replacing the previous version.
async function saveTextFile(filename, text) {
  await chrome.downloads.download({ url: dataUrl(text), filename, conflictAction: "overwrite", saveAs: false });
}

async function saveEmailsFile() {
  const { emails } = await getAll();
  await saveTextFile(EMAIL_FILE, buildEmailsFile(emails));
}

async function saveCaptchaFile() {
  const { captchaDomains } = await getAll();
  await saveTextFile(CAPTCHA_FILE, buildCaptchaFile(captchaDomains));
}

// Clears the working data: log, review queue, extracted emails and CAPTCHA list.
// Profile, domain list and sentHosts are kept, so a sent domain is never contacted again.
async function clearAll() {
  await save({ log: [], queue: [], emails: [], captchaDomains: [] });
}

// Inject the content script (idempotent) and send it a message.
async function toContent(tabId, msg, timeoutMs = STEP_TIMEOUT_MS) {
  await withTimeout(chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }), STEP_TIMEOUT_MS, "load page script");
  return withTimeout(chrome.tabs.sendMessage(tabId, msg), timeoutMs, `page step ${msg.type}`);
}

// Some pages render their form a moment after load. Retry the scan if no form is found yet.
async function scanWithRetry(tabId, tries = 3) {
  let scan = await toContent(tabId, { type: "scan" });
  for (let i = 1; i < tries && scan.forms.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 500));
    scan = await toContent(tabId, { type: "scan" });
  }
  return scan;
}

// Translates text with Chrome's built-in on-device Translator, run in the page.
// Returns { ok, text } or { ok: false, reason }. Nothing is sent to an outside service.
async function translateInPage(tabId, text, target) {
  let res;
  try {
    [res] = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [text, target],
        func: async (text, target) => {
          try {
            if (typeof Translator === "undefined") return { ok: false, reason: "translator-api-missing" };
            const availability = await Translator.availability({ sourceLanguage: "en", targetLanguage: target });
            if (availability === "unavailable") return { ok: false, reason: "language-pair-unavailable" };
            const translator = await Translator.create({ sourceLanguage: "en", targetLanguage: target });
            return { ok: true, text: await translator.translate(text) };
          } catch (err) {
            return { ok: false, reason: String((err && err.message) || err) };
          }
        },
      }),
      TRANSLATE_TIMEOUT_MS,
      "translate"
    );
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err) }; // the page is sent in the site's language if this fails
  }
  return res?.result ?? { ok: false, reason: "no-result" };
}

// Returns a profile whose message and subject are in the site's language, plus a log note.
async function localizeProfile(tabId, profile, host, lang) {
  if (!needsTranslation(lang)) return { profile, note: "" };
  const target = siteLanguage(lang);
  const message = (profile.template || "").replaceAll("{domain}", host).replaceAll("{company}", profile.company || "");

  const msg = await translateInPage(tabId, message, target);
  if (!msg.ok) return { profile, note: `not-translated(${msg.reason})` };

  let subject = profile.subject;
  if (profile.subject) {
    const subj = await translateInPage(tabId, profile.subject, target);
    if (subj.ok) subject = subj.text;
  }
  return { profile: { ...profile, template: msg.text, subject }, note: `translated-to=${target}` };
}

// ---------- form selection ----------

// Returns the best candidate on a scanned page, or null.
function pickForm(scan) {
  const candidates = scan.forms
    .map((form) => ({ form, score: scoreForm(form) }))
    .filter(({ score }) => score.fieldMap.message !== undefined || score.fieldMap.email !== undefined);
  return candidates.find((c) => c.score.level === "high") ?? candidates[0] ?? null;
}

// ---------- per-domain flow ----------

// token.aborted is set when the domain runs out of time; from then on nothing is submitted.
async function processDomain(tabId, entry, profile, dryRun, token) {
  // Use the URL the site redirected to (e.g. enag.fr -> www.enag.fr) as the base.
  const { links, finalUrl, html } = await collectLinksSafe(tabId, entry.url);
  // Contact pages first, then the home page itself: some sites put the form right on it.
  const candidates = [...new Set([...findContactLinks(links, finalUrl).slice(0, MAX_CONTACT_PAGES), finalUrl])];

  // Every email address seen on any page of this domain, kept on the token so it is saved whatever the outcome.
  const emails = token.emails;
  const remember = (text, pageUrl) => {
    for (const email of extractEmails(text)) if (!emails.has(email)) emails.set(email, pageUrl);
  };
  remember(html, finalUrl);
  const collect = async (pageUrl) => remember(await pageHtml(tabId).catch(() => ""), pageUrl);

  let fallback = null;
  let scanError = null;
  const attempts = []; // what each candidate page offered, for the log
  for (const pageUrl of candidates) {
    if (stopRequested || token.aborted) return { status: "skipped", reason: stopRequested ? "stopped" : "timed out" };
    await go(tabId, pageUrl);
    await collect(pageUrl);
    let scan;
    try {
      scan = await scanWithRetry(tabId);
    } catch (err) {
      scanError = String(err?.message ?? err); // keep it for the log, then try the next candidate
      attempts.push(`${pageUrl} -> scan-error`);
      continue;
    }
    if (scan.captcha) {
      token.formSeen = true;
      // Never submit behind a CAPTCHA, but still fill the form so the review tab is ready.
      const pick = pickForm(scan);
      let note = "no form found";
      if (pick) {
        const localized = await localizeProfile(tabId, profile, entry.host, scan.lang);
        const plan = buildFillPlan(pick.form, localized.profile, entry.host);
        const applied = await toContent(tabId, { type: "fill", formIndex: pick.form.index, fills: plan.fills });
        note = [summarizePlan(plan, applied), localized.note].filter(Boolean).join("; ");
      }
      return { status: "queued", reason: `captcha; ${note}`, pageUrl };
    }
    attempts.push(`${pageUrl} -> ${scan.forms.length} form(s)`);

    const pick = pickForm(scan);
    if (!pick) continue;
    token.formSeen = true; // a form that could be used (high or low confidence)
    if (pick.score.level !== "high") {
      fallback = fallback ?? { pageUrl, reason: pick.score.reason };
      continue;
    }
    return submitPick({ tabId, pick, pageUrl, profile, dryRun, host: entry.host, lang: scan.lang, token });
  }

  // A form exists but is low confidence: queued for review, no emails needed.
  if (fallback) return { status: "queued", reason: fallback.reason, pageUrl: fallback.pageUrl };

  // No usable form on the site: its email addresses are kept for the export (see runEntryBody).
  if (scanError) return { status: "queued", reason: `scan-error: ${scanError}`, pageUrl: entry.url };
  const tried = attempts.length ? attempts.join(" | ") : "no contact links found";
  return { status: "queued", reason: `no-usable-form (${tried})`, pageUrl: entry.url };
}

async function collectLinksSafe(tabId, url) {
  await go(tabId, url);
  const finalUrl = (await chrome.tabs.get(tabId)).url || url;
  const html = await pageHtml(tabId).catch(() => "");
  try {
    return { links: await collectLinks(tabId), finalUrl, html };
  } catch {
    return { links: [], finalUrl, html };
  }
}

async function submitPick({ tabId, pick, pageUrl, profile, dryRun, host, lang, token }) {
  const localized = await localizeProfile(tabId, profile, host, lang);
  const plan = buildFillPlan(pick.form, localized.profile, host);
  const applied = await toContent(tabId, { type: "fill", formIndex: pick.form.index, fills: plan.fills });
  const summary = [summarizePlan(plan, applied), localized.note].filter(Boolean).join("; ");

  if (dryRun) return { status: "skipped", reason: `dry-run; ${summary}`, pageUrl };

  await new Promise((r) => setTimeout(r, 300 + Math.random() * 400)); // brief human-like pause
  if (token.aborted || stopRequested) return { status: "skipped", reason: stopRequested ? "stopped" : "timed out", pageUrl };

  // Rate limit gate: wait for a free slot, never skip. The slot is taken under the lock, so
  // domains working at the same time cannot both pass the gap check.
  token.waiting = true;
  try {
    for (;;) {
      if (stopRequested) return { status: "skipped", reason: "stopped", pageUrl };
      if (token.aborted) return { status: "skipped", reason: "timed out", pageUrl };
      const gate = await locked(async () => {
        const state = await getAll();
        const now = Date.now();
        const result = canSubmit(state, now, LIMITS);
        if (result.ok) await save(nextState(state, now)); // counted now, so the next domain waits its turn
        return result;
      });
      if (gate.ok) break;
      if (gate.reason === "daily-cap") return { status: "skipped", reason: "daily-cap", pageUrl };
      await new Promise((r) => setTimeout(r, Math.min(gate.waitMs, 5000)));
    }
  } finally {
    token.waiting = false;
  }

  const before = (await chrome.tabs.get(tabId)).url;
  let verdict;
  let gone = false; // the page went away while submitting (a full page post does this)
  try {
    verdict = await toContent(tabId, { type: "submit", formIndex: pick.form.index }, SUBMIT_TIMEOUT_MS);
  } catch (err) {
    gone = true;
    verdict = { outcome: "unverified", reason: isTimeout(err) ? "no answer from the page" : "the page changed during the submit" };
  }
  // The address is read from the browser, not the page, so it works even when the page is stuck.
  const after = await withTimeout(chrome.tabs.get(tabId), STEP_TIMEOUT_MS, "read address").then((t) => t.url).catch(() => before);
  if (after !== before) gone = true;
  // Not yet confirmed, but the page moved on: read the confirmation from the page it landed on.
  if (verdict?.outcome !== "confirmed" && verdict?.outcome !== "rejected" && gone) {
    verdict = await confirmOnLanding(tabId, pick.form.index, before).catch(() => verdict);
  }

  // Only a confirmed submit is "sent". A refused one goes back to the review queue, and an
  // unconfirmed one is recorded as "sent?" so the domain is never submitted to again.
  if (verdict?.outcome === "rejected") {
    return { status: "queued", reason: `rejected: ${verdict.reason}; ${summary}`, pageUrl };
  }
  const confirmed = verdict?.outcome === "confirmed";
  if (confirmed || verdict?.outcome === "unverified") {
    await locked(async () => {
      const state = await getAll();
      await save({ sentHosts: [...new Set([...state.sentHosts, host])] });
    });
  }
  if (confirmed) return { status: "sent", reason: `confirmed: ${verdict.reason}; ${summary}`, pageUrl };
  return { status: "sent?", reason: `not confirmed: ${verdict?.reason ?? "no answer"}; ${summary}`, pageUrl };
}

// Reads the confirmation from the page the submit landed on, once that page has loaded.
async function confirmOnLanding(tabId, formIndex, startUrl) {
  await waitForLoad(tabId, 10000);
  return toContent(tabId, { type: "confirm", formIndex, startUrl }, STEP_TIMEOUT_MS);
}

// ---------- licence ----------

// Fingerprint of this extension's own scripts, the same bytes the build script hashes.
// Returns "" if the files cannot be read (for example in a test environment).
let fingerprintMemo = null;
async function buildFingerprint() {
  if (fingerprintMemo !== null) return fingerprintMemo;
  try {
    const files = ["background.js", "content.js", "popup/popup.js"];
    const texts = [];
    for (const f of files) texts.push(await (await fetch(chrome.runtime.getURL(f))).text());
    const bytes = new TextEncoder().encode(texts.join("\n--fillhero--\n"));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    fingerprintMemo = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    fingerprintMemo = "";
  }
  return fingerprintMemo;
}

// Returns { allowed, reason }. Asks the server at most once a day; otherwise uses the saved result.
// A key that cannot be checked keeps working for 72 hours after its last successful check.
async function checkLicence() {
  const s = await chrome.storage.local.get(["licenceKey", "licenceCache"]);
  const key = s.licenceKey || "";
  const cache = s.licenceCache || null;
  const now = Date.now();
  if (!key) return { allowed: false, reason: "no-licence" };
  if (cache && cache.key === key && !needsCheck(cache, now)) return { allowed: true, reason: "cached" };

  let serverAnswer = null;
  try {
    const build = await buildFingerprint();
    const res = await withTimeout(
      fetch(CFG.licenceUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, build }) }),
      10000,
      "licence check"
    );
    if (res.ok) {
      const data = await res.json();
      if (typeof data?.valid === "boolean") serverAnswer = data;
    }
  } catch {
    serverAnswer = null; // no answer: the grace period decides
  }
  const decision = decide(cache, key, now, serverAnswer);
  await chrome.storage.local.set({ licenceCache: decision.cache });
  return { allowed: decision.allowed, reason: decision.reason };
}

// Checks the licence when the extension starts, so a problem shows up before the first run.
// Failures are ignored here; the check at run time still refuses anything not valid.
chrome.runtime.onStartup?.addListener(() => checkLicence().catch(() => {}));
checkLicence().catch(() => {});

// What the popup shows. Reads only what is saved, so it never calls the server.
async function licenceStatus() {
  const s = await chrome.storage.local.get(["licenceKey", "licenceCache"]);
  const key = s.licenceKey || "";
  const cache = s.licenceCache || null;
  // Valid only if the last successful check is recent enough and the key has not expired.
  const now = Date.now();
  const valid = Boolean(
    key && cache && cache.key === key && cache.valid && now - (cache.checkedAt || 0) < GRACE_MS && !isExpired(cache.expiresAt, now)
  );
  return {
    hasKey: Boolean(key),
    valid,
    customer: valid ? cache.customer || "" : "",
    expiresAt: valid ? cache.expiresAt ?? null : null,
    daysLeft: valid ? daysLeft(cache.expiresAt, now) : null,
    checkedAt: cache?.checkedAt || 0,
  };
}

// ---------- history watchdog ----------

// Remembers the pages this extension opened, so they can be removed from history later.
function rememberVisit(url, finalUrl) {
  return locked(async () => {
    const s = await chrome.storage.local.get(["visitedUrls"]);
    const list = new Set(s.visitedUrls ?? []);
    for (const u of [url, finalUrl]) if (u && /^https?:/.test(u)) list.add(u);
    await save({ visitedUrls: [...list] });
  });
}

// Counts one domain visit. Every HISTORY_CLEAR_EVERY visits, removes the pages this extension
// visited from Chrome's history. Other history is left alone.
function countVisitAndMaybeClear() {
  return locked(async () => {
    const s = await chrome.storage.local.get(["visitCount", "visitedUrls"]);
    const count = (s.visitCount ?? 0) + 1;
    if (count < HISTORY_CLEAR_EVERY) return save({ visitCount: count });

    let removed = 0;
    for (const url of s.visitedUrls ?? []) {
      try {
        await chrome.history.deleteUrl({ url });
        removed++;
      } catch {
        // already gone, or the history permission is not granted; counted as not removed
      }
    }
    await save({ visitCount: 0, visitedUrls: [] });
    await appendLog({
      host: "",
      status: "history-cleared",
      reason: `${count} domain visits; ${removed} of ${(s.visitedUrls ?? []).length} pages removed from browser history`,
      pageUrl: "",
    });
  });
}

// ---------- run loop ----------

// Closes every tab this extension opened and is still tracking, including review tabs.
async function closeAllManagedTabs() {
  for (const id of [...managedTabs]) await closeTab(id);
}

// Shows a desktop notification with the results. Quietly skipped if notifications are blocked.
async function notifyRunFinished(counts, stopped) {
  const title = stopped ? "Fill Hero: run stopped" : "Fill Hero: run finished";
  const message = `${counts.sent} confirmed sent, ${counts.unconfirmed} not confirmed, ${counts.queued} queued for review, ${counts.failed} failed, ${counts.skipped} skipped.`;
  try {
    await chrome.notifications.create({ type: "basic", iconUrl: chrome.runtime.getURL("icon.png"), title, message });
  } catch {
    // The run has already finished; a blocked notification must not matter.
  }
}

// Up to WORKERS domains at once, each in its own tab. When the run ends, every tab it opened
// is closed and a notification is shown.
async function runLoop(domains) {
  running = true;
  stopRequested = false;
  const { dryRun } = await getAll();
  const counts = { sent: 0, unconfirmed: 0, queued: 0, failed: 0, skipped: 0 };
  let next = 0;
  const worker = async () => {
    while (!stopRequested && next < domains.length) {
      const entry = domains[next++];
      await runEntry(entry, dryRun, counts).catch(async (err) => {
        counts.failed++;
        await logEntry({ host: entry.host ?? entry.input, status: "failed", reason: String(err?.message ?? err), pageUrl: "" }).catch(() => {});
      });
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(WORKERS, domains.length) }, worker));
  } finally {
    const stopped = stopRequested;
    running = false;
    stopRequested = false;
    // Refresh the two text files at the end of every run. A failed save must not break the run.
    await saveEmailsFile().catch(() => {});
    await saveCaptchaFile().catch(() => {});
    // The run is over: close every tab it opened, then say so.
    await closeAllManagedTabs().catch(() => {});
    await notifyRunFinished(counts, stopped);
  }
}

// Hosts being worked on right now. The same host listed twice must never be worked on at once.
const hostsInProgress = new Set();

// Works one domain in its own tab, and records the result in counts.
async function runEntry(entry, dryRun, counts) {
  if (entry.ok && hostsInProgress.has(entry.host)) {
    await logEntry({ host: entry.host, status: "skipped", reason: "duplicate-in-run", pageUrl: entry.url });
    counts.skipped++;
    return;
  }
  if (!entry.ok) return runEntryBody(entry, dryRun, counts);
  hostsInProgress.add(entry.host);
  try {
    return await runEntryBody(entry, dryRun, counts);
  } finally {
    hostsInProgress.delete(entry.host);
  }
}

async function runEntryBody(entry, dryRun, counts) {
  if (!entry.ok) {
    await logEntry({ host: entry.input, status: "failed", reason: entry.reason, pageUrl: "" });
    counts.failed++;
    return;
  }
  const { log, profile, sentHosts } = await getAll();
  if (hasSent(log, entry.host) || sentHosts.includes(entry.host)) {
    await logEntry({ host: entry.host, status: "skipped", reason: "already-sent", pageUrl: entry.url });
    counts.skipped++;
    return;
  }

  const tab = await openTab("about:blank", dryRun, true);
  // emails: email -> page it was found on. formSeen: a form (or CAPTCHA) was found on one of the pages.
  const token = { aborted: false, waiting: false, emails: new Map(), formSeen: false };
  let keepOpen = dryRun;
  try {
    const r = await withDeadline(processDomain(tab.id, entry, profile, dryRun, token), DOMAIN_TIMEOUT_MS, `domain ${entry.host}`, token).catch((err) => {
      token.aborted = true; // a late submit from the abandoned attempt is refused
      throw err;
    });
    if (r.status === "queued") {
      const reason = r.reason;
      if (reason.startsWith("captcha")) await storeCaptchaDomain(entry.host, r.pageUrl);
      await queueEntry({ host: entry.host, url: entry.url, reason, pageUrl: r.pageUrl });
      counts.queued++;
    } else {
      await logEntry({ host: entry.host, status: r.status, reason: r.reason, pageUrl: r.pageUrl });
      if (r.status === "sent") counts.sent++;
      else if (r.status === "sent?") counts.unconfirmed++;
      else if (r.status === "failed") counts.failed++;
      else counts.skipped++;
    }
  } catch (err) {
    keepOpen = false; // a stuck or stopped tab is never left open
    const reason = stopRequested
      ? "stopped by the user"
      : isTimeout(err)
        ? `timed out after ${DOMAIN_TIMEOUT_MS / 1000} s; nothing more was done here`
        : String(err?.message ?? err);
    await logEntry({ host: entry.host, status: stopRequested ? "skipped" : "failed", reason, pageUrl: entry.url });
    if (stopRequested) counts.skipped++;
    else counts.failed++;
  } finally {
    // Addresses are kept only for sites where no form was found. This holds even when the domain
    // timed out or failed part-way: the addresses were read from the pages it did reach.
    const found = [...token.emails].map(([email, pageUrl]) => ({ email, pageUrl }));
    if (!token.formSeen && found.length) await storeEmails(entry.host, found).catch(() => {});
    activeTabs.delete(tab.id);
    if (!keepOpen) await closeTab(tab.id);
    await countVisitAndMaybeClear().catch(() => {});
  }
}

// ---------- queue actions ----------

// Opens the queued page in a visible tab and fills the best form.
// The user reviews and clicks the page's own submit button; the tab stays open for review.
async function approveQueued(host) {
  const { queue, profile } = await getAll();
  const item = queue.find((q) => q.host === host);
  if (!item) return;

  const tab = await openTab("about:blank", true);
  reviewTabs.set(tab.id, null); // not loaded yet, so a redirect while loading does not count as a submit
  await go(tab.id, item.pageUrl); // same race-free navigation as the run loop
  reviewTabs.set(tab.id, item.pageUrl);
  const scan = await scanWithRetry(tab.id);
  const pick = pickForm(scan);
  if (!pick) {
    await logEntry({ host, status: "failed", reason: "form-not-found", pageUrl: item.pageUrl });
  } else {
    const localized = await localizeProfile(tab.id, profile, host, scan.lang);
    const plan = buildFillPlan(pick.form, localized.profile, host);
    const applied = await toContent(tab.id, { type: "fill", formIndex: pick.form.index, fills: plan.fills });
    const summary = [summarizePlan(plan, applied), localized.note].filter(Boolean).join("; ");
    await logEntry({ host, status: "filled-for-review", reason: summary, pageUrl: item.pageUrl });
  }
  await save({ queue: (await getAll()).queue.filter((q) => q.host !== host) });
}

async function skipQueued(host) {
  const { queue } = await getAll();
  await save({ queue: queue.filter((q) => q.host !== host) });
  await logEntry({ host, status: "skipped", reason: "manual-skip", pageUrl: "" });
}

async function exportEmailsCsv() {
  const { emails } = await getAll();
  const url = "data:text/csv;charset=utf-8," + encodeURIComponent(emailsToCsv(emails));
  await chrome.downloads.download({ url, filename: "fill-hero-emails.csv", saveAs: true });
}

// ---------- messages from the popup ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "start": {
        if (running) return sendResponse({ ok: false, reason: "already-running" });
        const licence = await checkLicence();
        if (!licence.allowed) return sendResponse({ ok: false, reason: licence.reason });
        if (msg.profile) await save({ profile: msg.profile });
        await save({ dryRun: !!msg.dryRun });
        runLoop(parseDomainList(msg.domains)).catch((err) => console.error("run failed:", err?.message ?? err));
        return sendResponse({ ok: true });
      }
      case "licenceStatus":
        return sendResponse(await licenceStatus());
      case "setLicence": {
        // Saves a new key (or removes the key when empty), then checks it once now.
        const key = String(msg.key ?? "").trim().toUpperCase();
        await chrome.storage.local.set({ licenceKey: key, licenceCache: null });
        if (!key) return sendResponse({ allowed: false, reason: "no-licence" });
        return sendResponse(await checkLicence());
      }
      case "stop":
        stopRequested = true;
        // Closing the open tabs cancels page steps that are waiting, so Stop takes effect at once.
        for (const id of [...activeTabs]) await closeTab(id);
        return sendResponse({ ok: true });
      case "approveQueued": {
        if (running) return sendResponse({ ok: false, reason: "stop-the-run-first" });
        const licence = await checkLicence();
        if (!licence.allowed) return sendResponse({ ok: false, reason: licence.reason });
        await approveQueued(msg.host);
        return sendResponse({ ok: true });
      }
      case "closeReviewTabs":
        await closeReviewTabs();
        return sendResponse({ ok: true });
      case "skipQueued":
        await skipQueued(msg.host);
        return sendResponse({ ok: true });
      case "exportEmailsCsv":
        await exportEmailsCsv();
        return sendResponse({ ok: true });
      case "saveEmailsFile":
        await saveEmailsFile();
        return sendResponse({ ok: true });
      case "saveCaptchaFile":
        await saveCaptchaFile();
        return sendResponse({ ok: true });
      case "clearAll":
        if (running) return sendResponse({ ok: false, reason: "stop-the-run-first" });
        await clearAll();
        return sendResponse({ ok: true });
      case "state":
        return sendResponse({ running, openTabs: managedTabs.length, ...(await getAll()) });
      default:
        return sendResponse({ ok: false, reason: "unknown-message" });
    }
  })();
  return true;
});
