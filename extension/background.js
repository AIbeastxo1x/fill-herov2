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

const LIMITS = { gapMs: 25000, dailyCap: 5000 };
const MAX_CONTACT_PAGES = 3;
const MAX_TABS = 5;
const STEP_TIMEOUT_MS = 20000; // any single page step gives up after this
const TRANSLATE_TIMEOUT_MS = 60000; // the first on-device translation may download a model, so it gets longer
const SUBMIT_TIMEOUT_MS = 60000; // submitting can be slow on some sites, so it gets longer than a scan or fill
const DOMAIN_TIMEOUT_MS = 180000; // a whole domain gives up after this, so one bad site cannot stall a run
const HISTORY_CLEAR_EVERY = 500; // domain visits between history clean-ups
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
let currentTabId = null; // the tab of the domain being worked on, so Stop can close it

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

async function logEntry(entry) {
  const { log } = await getAll();
  await save({ log: addLog(log, { ...entry, at: Date.now() }) });
}

async function queueEntry(entry) {
  const { queue } = await getAll();
  await save({ queue: [...queue.filter((q) => q.host !== entry.host), { ...entry, at: Date.now() }] });
  await logEntry({ host: entry.host, status: "queued", reason: entry.reason, pageUrl: entry.pageUrl });
}

// ---------- tab management (at most MAX_TABS open at once) ----------

// Tabs this extension opened, oldest first. A tab leaves the list when it is closed
// by us or by the user.
const managedTabs = [];
chrome.tabs.onRemoved.addListener((id) => {
  const i = managedTabs.indexOf(id);
  if (i >= 0) managedTabs.splice(i, 1);
});

// Opens a tab. If MAX_TABS are already open, closes the oldest one first.
// Safe because runs are sequential, and approveQueued is refused during a run.
async function openTab(url, active) {
  while (managedTabs.length >= MAX_TABS) {
    const victim = managedTabs.shift();
    await chrome.tabs.remove(victim).catch(() => {});
  }
  const tab = await chrome.tabs.create({ url, active });
  managedTabs.push(tab.id);
  return tab;
}

async function closeTab(id) {
  const i = managedTabs.indexOf(id);
  if (i >= 0) managedTabs.splice(i, 1);
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

// Stores new addresses for a host. Returns how many were new.
async function storeEmails(host, pageUrl, list) {
  const { emails } = await getAll();
  const known = new Set(emails.filter((e) => e.host === host).map((e) => e.email));
  const at = Date.now();
  const fresh = list.filter((email) => !known.has(email)).map((email) => ({ host, email, pageUrl, at }));
  if (fresh.length) await save({ emails: [...emails, ...fresh] });
  return fresh.length;
}

// Records a domain that stopped at a CAPTCHA. One row per domain; the newest visit wins.
async function storeCaptchaDomain(host, pageUrl) {
  const { captchaDomains } = await getAll();
  await save({ captchaDomains: [...captchaDomains.filter((c) => c.host !== host), { host, pageUrl, at: Date.now() }] });
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
  const candidates = findContactLinks(links, finalUrl).slice(0, MAX_CONTACT_PAGES);

  // Every email address seen on the pages visited for this domain.
  const emails = new Set(extractEmails(html));
  const collect = async () => {
    for (const e of extractEmails(await pageHtml(tabId).catch(() => ""))) emails.add(e);
  };

  let fallback = null;
  let scanError = null;
  const attempts = []; // what each candidate page offered, for the log
  for (const pageUrl of candidates) {
    if (stopRequested || token.aborted) return { status: "skipped", reason: stopRequested ? "stopped" : "timed out" };
    await go(tabId, pageUrl);
    await collect();
    let scan;
    try {
      scan = await scanWithRetry(tabId);
    } catch (err) {
      scanError = String(err?.message ?? err); // keep it for the log, then try the next candidate
      attempts.push(`${pageUrl} -> scan-error`);
      continue;
    }
    if (scan.captcha) {
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
    if (pick.score.level !== "high") {
      fallback = fallback ?? { pageUrl, reason: pick.score.reason };
      continue;
    }
    return submitPick({ tabId, pick, pageUrl, profile, dryRun, host: entry.host, lang: scan.lang, token });
  }

  // A form exists but is low confidence: queued for review, no emails needed.
  if (fallback) return { status: "queued", reason: fallback.reason, pageUrl: fallback.pageUrl };

  // No usable form at all: keep the email addresses for the email export.
  const noForm = { status: "queued", emails: [...emails] };
  if (scanError) return { ...noForm, reason: `scan-error: ${scanError}`, pageUrl: entry.url };
  const tried = attempts.length ? attempts.join(" | ") : "no contact links found";
  return { ...noForm, reason: `no-usable-form (${tried})`, pageUrl: entry.url };
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

  // Rate limit gate: wait, never skip.
  for (;;) {
    if (stopRequested) return { status: "skipped", reason: "stopped", pageUrl };
    if (token.aborted) return { status: "skipped", reason: "timed out", pageUrl };
    const state = await getAll();
    const gate = canSubmit(state, Date.now(), LIMITS);
    if (gate.ok) break;
    if (gate.reason === "daily-cap") return { status: "skipped", reason: "daily-cap", pageUrl };
    await new Promise((r) => setTimeout(r, Math.min(gate.waitMs, 5000)));
  }

  await new Promise((r) => setTimeout(r, 300 + Math.random() * 400)); // brief human-like pause
  if (token.aborted || stopRequested) return { status: "skipped", reason: stopRequested ? "stopped" : "timed out", pageUrl };
  const before = (await chrome.tabs.get(tabId)).url;
  let result;
  try {
    result = await toContent(tabId, { type: "submit", formIndex: pick.form.index }, SUBMIT_TIMEOUT_MS);
  } catch (err) {
    // A timeout means we cannot tell whether the form went through, so it is never a clean send.
    // A navigation during submit usually means it did.
    result = isTimeout(err) ? { outcome: "unknown" } : { outcome: "confirmed" };
  }
  // The address is read from the browser, not the page, so it works even when the page is stuck.
  const after = await withTimeout(chrome.tabs.get(tabId), STEP_TIMEOUT_MS, "read address").then((t) => t.url).catch(() => before);
  const outcome = result?.outcome === "confirmed" || after !== before ? "sent" : "sent?";

  const state = await getAll();
  await save({
    ...nextState(state, Date.now()),
    sentHosts: [...new Set([...state.sentHosts, host])],
  });
  return { status: outcome, reason: summary, pageUrl };
}

// ---------- history watchdog ----------

// Remembers the pages this extension opened, so they can be removed from history later.
async function rememberVisit(url, finalUrl) {
  const s = await chrome.storage.local.get(["visitedUrls"]);
  const list = new Set(s.visitedUrls ?? []);
  for (const u of [url, finalUrl]) if (u && /^https?:/.test(u)) list.add(u);
  await save({ visitedUrls: [...list] });
}

// Counts one domain visit. Every HISTORY_CLEAR_EVERY visits, removes the pages this extension
// visited from Chrome's history. Other history is left alone.
async function countVisitAndMaybeClear() {
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
  await logEntry({
    host: "",
    status: "history-cleared",
    reason: `${count} domain visits; ${removed} of ${(s.visitedUrls ?? []).length} pages removed from browser history`,
    pageUrl: "",
  });
}

// ---------- run loop ----------

// One domain at a time. A tab is closed after its form is submitted successfully.
// Dry-run and queued tabs stay open for review; the oldest of those closes when
// more than MAX_TABS would be open.
async function runLoop(domains) {
  running = true;
  stopRequested = false;
  const { dryRun } = await getAll();
  try {
    for (const entry of domains) {
      if (stopRequested) break;
      if (!entry.ok) {
        await logEntry({ host: entry.input, status: "failed", reason: entry.reason, pageUrl: "" });
        continue;
      }
      const { log, profile, sentHosts } = await getAll();
      if (hasSent(log, entry.host) || sentHosts.includes(entry.host)) {
        await logEntry({ host: entry.host, status: "skipped", reason: "already-sent", pageUrl: entry.url });
        continue;
      }

      const tab = await openTab("about:blank", dryRun);
      currentTabId = tab.id;
      const token = { aborted: false };
      let keepOpen = dryRun;
      try {
        const r = await withTimeout(processDomain(tab.id, entry, profile, dryRun, token), DOMAIN_TIMEOUT_MS, `domain ${entry.host}`).catch((err) => {
          token.aborted = true; // a late submit from the abandoned attempt is refused
          throw err;
        });
        if (r.status === "queued") {
          let reason = r.reason;
          if (r.emails) reason += `; emails-stored=${await storeEmails(entry.host, r.pageUrl, r.emails)}`;
          if (reason.startsWith("captcha")) await storeCaptchaDomain(entry.host, r.pageUrl);
          await queueEntry({ host: entry.host, url: entry.url, reason, pageUrl: r.pageUrl });
          keepOpen = true; // for review
        } else {
          await logEntry({ host: entry.host, status: r.status, reason: r.reason, pageUrl: r.pageUrl });
          if (r.status === "sent?") keepOpen = true; // unverified: leave for a look
        }
      } catch (err) {
        keepOpen = false; // a stuck or stopped tab is never left open for review
        const reason = stopRequested
          ? "stopped by the user"
          : isTimeout(err)
            ? `timed out after ${DOMAIN_TIMEOUT_MS / 1000} s; nothing more was done here`
            : String(err?.message ?? err);
        await logEntry({ host: entry.host, status: stopRequested ? "skipped" : "failed", reason, pageUrl: entry.url });
      } finally {
        currentTabId = null;
        if (!keepOpen) await closeTab(tab.id);
        await countVisitAndMaybeClear().catch(() => {});
      }
    }
  } finally {
    running = false;
    stopRequested = false;
    // Refresh the two text files at the end of every run. A failed save must not break the run.
    await saveEmailsFile().catch(() => {});
    await saveCaptchaFile().catch(() => {});
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
  await go(tab.id, item.pageUrl); // same race-free navigation as the run loop
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
      case "start":
        if (running) return sendResponse({ ok: false, reason: "already-running" });
        if (msg.profile) await save({ profile: msg.profile });
        await save({ dryRun: !!msg.dryRun });
        runLoop(parseDomainList(msg.domains));
        return sendResponse({ ok: true });
      case "stop":
        stopRequested = true;
        // Closing the open tab cancels a page step that is waiting, so Stop takes effect at once.
        if (currentTabId !== null) await closeTab(currentTabId);
        return sendResponse({ ok: true });
      case "approveQueued":
        if (running) return sendResponse({ ok: false, reason: "stop-the-run-first" });
        await approveQueued(msg.host);
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
