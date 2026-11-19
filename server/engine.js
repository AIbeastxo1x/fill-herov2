// The run loop: the extension's background logic, driven by a headless Chromium (Playwright)
// instead of Chrome tabs. It reuses the same pure modules in src/lib and the same page script,
// src/content.js, so matching, scoring, filling and verification behave the same way.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { findContactLinks } from "../src/lib/contactLinks.js";
import { scoreForm } from "../src/lib/score.js";
import { canSubmit, nextState } from "../src/lib/rateLimit.js";
import { addLog, hasSent } from "../src/lib/queue.js";
import { buildFillPlan, summarizePlan } from "../src/lib/fillPlan.js";
import { siteLanguage, needsTranslation } from "../src/lib/language.js";
import { extractEmails } from "../src/lib/emails.js";

export const LIMITS = { gapMs: 25000, dailyCap: 5000 };
export const MAX_CONTACT_PAGES = 3;
const PAGE_TIMEOUT_MS = 20000;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_PATH = path.join(HERE, "..", "src", "content.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The best candidate on a scanned page: a high-confidence form if there is one, else the first.
function pickForm(scan) {
  const candidates = scan.forms
    .map((form) => ({ form, score: scoreForm(form) }))
    .filter(({ score }) => score.fieldMap.message !== undefined || score.fieldMap.email !== undefined);
  return candidates.find((c) => c.score.level === "high") ?? candidates[0] ?? null;
}

export class Engine {
  // store: from store.js. launchOptions: passed to chromium.launch (headless by default).
  constructor(store, { launchOptions = {} } = {}) {
    this.store = store;
    this.launchOptions = launchOptions;
    this.running = false;
    this.stopRequested = false;
    this.current = null; // the run's promise, for tests
    this.contentJs = null;
  }

  status() {
    const s = this.store.get();
    return { running: this.running, dryRun: s.dryRun };
  }

  // Starts a run in the background. Throws if one is already running.
  start(domains, { dryRun }) {
    if (this.running) throw new Error("already-running");
    this.store.set({ dryRun: !!dryRun });
    this.running = true;
    this.stopRequested = false;
    this.current = this.run(domains, !!dryRun)
      .catch((err) => console.error("run failed:", err.message))
      .finally(() => {
        this.running = false;
        this.stopRequested = false;
      });
    return this.current;
  }

  stop() {
    this.stopRequested = true;
  }

  // ---------- store helpers ----------

  log(entry) {
    this.store.set({ log: addLog(this.store.get().log, { ...entry, at: Date.now() }) });
  }

  queue(entry) {
    const queue = this.store.get().queue.filter((q) => q.host !== entry.host);
    this.store.set({ queue: [...queue, { ...entry, at: Date.now() }] });
    this.log({ host: entry.host, status: "queued", reason: entry.reason, pageUrl: entry.pageUrl });
  }

  storeEmails(host, pageUrl, list) {
    const { emails } = this.store.get();
    const known = new Set(emails.filter((e) => e.host === host).map((e) => e.email));
    const at = Date.now();
    const fresh = list.filter((email) => !known.has(email)).map((email) => ({ host, email, pageUrl, at }));
    if (fresh.length) this.store.set({ emails: [...emails, ...fresh] });
    return fresh.length;
  }

  storeCaptchaDomain(host, pageUrl) {
    const { captchaDomains } = this.store.get();
    this.store.set({ captchaDomains: [...captchaDomains.filter((c) => c.host !== host), { host, pageUrl, at: Date.now() }] });
  }

  // ---------- page helpers ----------

  async loadContentScript() {
    if (!this.contentJs) this.contentJs = await fs.readFile(CONTENT_PATH, "utf8");
    return this.contentJs;
  }

  // Injects the page script once per page. Scan, fill and submit all run through it.
  async ensureContent(page) {
    const has = await page.evaluate(() => Boolean(window.__fillHero)).catch(() => false);
    if (!has) await page.addScriptTag({ content: await this.loadContentScript() });
  }

  async scan(page) {
    await this.ensureContent(page);
    return page.evaluate(() => window.__fillHero.scan());
  }

  // Some pages render their form a moment after load. Retry the scan if no form is found yet.
  async scanWithRetry(page, tries = 3) {
    let scan = await this.scan(page);
    for (let i = 1; i < tries && scan.forms.length === 0; i++) {
      await sleep(500);
      scan = await this.scan(page);
    }
    return scan;
  }

  async go(page, url) {
    await page.goto(url, { waitUntil: "load", timeout: PAGE_TIMEOUT_MS }).catch(() => {}); // a slow page still gets scanned
  }

  async collectLinks(page) {
    return page
      .evaluate(() => Array.from(document.querySelectorAll("a[href]")).map((a) => ({ href: a.getAttribute("href"), text: a.textContent || "" })))
      .catch(() => []);
  }

  // Translates with the browser's built-in Translator API when the page has it. Otherwise the
  // message goes out in English, and the log says so.
  async translateInPage(page, text, target) {
    try {
      return await page.evaluate(
        async ([text, target]) => {
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
        [text, target]
      );
    } catch (err) {
      return { ok: false, reason: String(err?.message ?? err) };
    }
  }

  async localizeProfile(page, profile, host, lang) {
    if (!needsTranslation(lang)) return { profile, note: "" };
    const target = siteLanguage(lang);
    const message = (profile.template || "").replaceAll("{domain}", host).replaceAll("{company}", profile.company || "");
    const msg = await this.translateInPage(page, message, target);
    if (!msg.ok) return { profile, note: `not-translated(${msg.reason})` };
    let subject = profile.subject;
    if (profile.subject) {
      const subj = await this.translateInPage(page, profile.subject, target);
      if (subj.ok) subject = subj.text;
    }
    return { profile: { ...profile, template: msg.text, subject }, note: `translated-to=${target}` };
  }

  async fill(page, formIndex, fills) {
    await this.ensureContent(page);
    return page.evaluate(([i, f]) => window.__fillHero.fillAndVerify(i, f), [formIndex, fills]);
  }

  // ---------- per-domain flow ----------

  async processDomain(page, entry, profile, dryRun) {
    await this.go(page, entry.url);
    const finalUrl = page.url() || entry.url; // the redirected address (e.g. enag.fr -> www.enag.fr)
    const links = await this.collectLinks(page);
    const emails = new Set(extractEmails(await page.content().catch(() => "")));
    const candidates = findContactLinks(links, finalUrl).slice(0, MAX_CONTACT_PAGES);

    const collect = async () => {
      for (const e of extractEmails(await page.content().catch(() => ""))) emails.add(e);
    };

    let fallback = null;
    let scanError = null;
    const attempts = [];
    for (const pageUrl of candidates) {
      if (this.stopRequested) return { status: "skipped", reason: "stopped" };
      await this.go(page, pageUrl);
      await collect();
      let scan;
      try {
        scan = await this.scanWithRetry(page);
      } catch (err) {
        scanError = String(err?.message ?? err);
        attempts.push(`${pageUrl} -> scan-error`);
        continue;
      }
      if (scan.captcha) {
        // Never submit behind a CAPTCHA, but still fill the form so the operator can see it.
        const pick = pickForm(scan);
        let note = "no form found";
        if (pick) {
          const localized = await this.localizeProfile(page, profile, entry.host, scan.lang);
          const plan = buildFillPlan(pick.form, localized.profile, entry.host);
          const applied = await this.fill(page, pick.form.index, plan.fills);
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
      return this.submitPick({ page, pick, pageUrl, profile, dryRun, host: entry.host, lang: scan.lang });
    }

    if (fallback) return { status: "queued", reason: fallback.reason, pageUrl: fallback.pageUrl };

    const noForm = { status: "queued", emails: [...emails] };
    if (scanError) return { ...noForm, reason: `scan-error: ${scanError}`, pageUrl: entry.url };
    const tried = attempts.length ? attempts.join(" | ") : "no contact links found";
    return { ...noForm, reason: `no-usable-form (${tried})`, pageUrl: entry.url };
  }

  async submitPick({ page, pick, pageUrl, profile, dryRun, host, lang }) {
    const localized = await this.localizeProfile(page, profile, host, lang);
    const plan = buildFillPlan(pick.form, localized.profile, host);
    const applied = await this.fill(page, pick.form.index, plan.fills);
    const summary = [summarizePlan(plan, applied), localized.note].filter(Boolean).join("; ");

    if (dryRun) return { status: "skipped", reason: `dry-run; ${summary}`, pageUrl };

    // Rate limit gate: wait for the gap, never skip, stop at the daily cap.
    for (;;) {
      if (this.stopRequested) return { status: "skipped", reason: "stopped", pageUrl };
      const gate = canSubmit(this.store.get(), Date.now(), LIMITS);
      if (gate.ok) break;
      if (gate.reason === "daily-cap") return { status: "skipped", reason: "daily-cap", pageUrl };
      await sleep(Math.min(gate.waitMs, 5000));
    }

    await sleep(300 + Math.random() * 400); // brief human-like pause
    const before = page.url();
    let result;
    try {
      await this.ensureContent(page);
      result = await page.evaluate(([i, url]) => window.__fillHero.submit(i, url), [pick.form.index, before]);
    } catch {
      result = { outcome: "confirmed" }; // the page navigated away during submit: a likely success
    }
    const after = page.url();
    const outcome = result?.outcome === "confirmed" || after !== before ? "sent" : "sent?";

    const state = this.store.get();
    this.store.set({
      ...nextState(state, Date.now()),
      sentHosts: [...new Set([...state.sentHosts, host])],
    });
    return { status: outcome, reason: summary, pageUrl };
  }

  // ---------- run loop ----------

  // One domain at a time, each in its own page. The browser closes when the run ends.
  async run(domains, dryRun) {
    const browser = await chromium.launch({ headless: true, ...this.launchOptions });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
      for (const entry of domains) {
        if (this.stopRequested) break;
        if (!entry.ok) {
          this.log({ host: entry.input, status: "failed", reason: entry.reason, pageUrl: "" });
          continue;
        }
        const { log, profile, sentHosts } = this.store.get();
        if (hasSent(log, entry.host) || sentHosts.includes(entry.host)) {
          this.log({ host: entry.host, status: "skipped", reason: "already-sent", pageUrl: entry.url });
          continue;
        }

        const page = await context.newPage();
        try {
          const r = await this.processDomain(page, entry, profile, dryRun);
          if (r.status === "queued") {
            let reason = r.reason;
            if (r.emails) reason += `; emails-stored=${this.storeEmails(entry.host, r.pageUrl, r.emails)}`;
            if (reason.startsWith("captcha")) this.storeCaptchaDomain(entry.host, r.pageUrl);
            this.queue({ host: entry.host, url: entry.url, reason, pageUrl: r.pageUrl });
          } else {
            this.log({ host: entry.host, status: r.status, reason: r.reason, pageUrl: r.pageUrl });
          }
        } catch (err) {
          this.log({ host: entry.host, status: "failed", reason: String(err?.message ?? err), pageUrl: entry.url });
        } finally {
          await page.close().catch(() => {});
        }
      }
    } finally {
      await browser.close().catch(() => {});
    }
  }
}
