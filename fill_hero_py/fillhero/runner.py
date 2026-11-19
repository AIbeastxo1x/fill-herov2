"""Drives Chromium with Playwright: visits each domain, finds the contact form, fills it,
and submits only when the form is recognised with high confidence and no CAPTCHA is present."""
import os
import random
import time

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

from .contact import find_contact_links
from .limits import can_submit, record_submit
from .matching import build_fill_plan, pick_form, summarize_plan
from .normalize import parse_domain_list
from .store import already_sent, append_log, load_json, load_state, now, save_json, save_state
from .translate import translate_profile

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "content.js"), encoding="utf-8") as _fh:
    CONTENT_JS = _fh.read()

LINKS_JS = """() => Array.from(document.querySelectorAll("a[href]"))
  .map(a => ({ href: a.getAttribute("href"), text: a.textContent || "" }))"""


def say(msg):
    print(msg, flush=True)


def _join(*parts):
    return "; ".join(p for p in parts if p)


class Runner:
    def __init__(self, settings, dry_run=None, headless=None):
        self.profile = settings["profile"]
        self.opts = settings["run"]
        self.files = settings["files"]
        self.domains = settings["domains"]
        self.dry_run = self.opts["dry_run"] if dry_run is None else dry_run
        self.headless = self.opts["headless"] if headless is None else headless
        self.open_pages = []
        self.stop_requested = False

    # ---------- browser ----------

    def open_context(self, pw, headless):
        os.makedirs(self.files["browser_profile"], exist_ok=True)
        return pw.chromium.launch_persistent_context(
            self.files["browser_profile"],
            headless=headless,
            viewport={"width": 1280, "height": 900},
            args=["--disable-blink-features=AutomationControlled"],
        )

    def open_page(self, ctx):
        # Keep at most max_tabs pages open; the oldest is closed first.
        self.open_pages = [p for p in self.open_pages if not p.is_closed()]
        while len(self.open_pages) >= self.opts["max_tabs"]:
            self.open_pages.pop(0).close()
        page = ctx.new_page()
        page.set_default_timeout(self.opts["page_timeout_seconds"] * 1000)
        self.open_pages.append(page)
        return page

    def close_page(self, page):
        if page in self.open_pages:
            self.open_pages.remove(page)
        if not page.is_closed():
            page.close()

    def goto(self, page, url):
        page.goto(url, wait_until="load", timeout=self.opts["page_timeout_seconds"] * 1000)

    def ensure_content(self, page):
        if not page.evaluate("() => !!window.__fillHero"):
            page.evaluate(CONTENT_JS)

    def scan(self, page, tries=3):
        """Scan the page's form. Retries briefly, since some forms render after load."""
        self.ensure_content(page)
        scan = page.evaluate("() => window.__fillHero.scan()")
        for _ in range(1, tries):
            if scan["forms"]:
                break
            time.sleep(1.5)
            self.ensure_content(page)
            scan = page.evaluate("() => window.__fillHero.scan()")
        return scan

    def fill(self, page, form_index, fills):
        payload = [{"index": f["index"], "value": f["value"]} for f in fills]
        return page.evaluate("async ([i, f]) => await window.__fillHero.fillAndVerify(i, f)", [form_index, payload])

    # ---------- one domain ----------

    def process_domain(self, page, entry):
        self.goto(page, entry["url"])
        links = page.evaluate(LINKS_JS)
        candidates = find_contact_links(links, page.url)[: self.opts["max_contact_pages"]]

        fallback = None
        scan_error = None
        attempts = []
        for url in candidates:
            if self.stop_requested:
                return {"status": "skipped", "reason": "stopped", "pageUrl": url}
            try:
                self.goto(page, url)
                scan = self.scan(page)
            except PlaywrightError as err:
                scan_error = str(err).splitlines()[0]
                attempts.append(f"{url} -> scan-error")
                continue

            if scan.get("captcha"):
                # Never submit behind a CAPTCHA, but fill the form so the review page is ready.
                pick = pick_form(scan)
                note = "no form found"
                if pick:
                    profile, lnote = translate_profile(page, self.profile, entry["host"], scan.get("lang"))
                    plan = build_fill_plan(pick["form"], profile, entry["host"])
                    applied = self.fill(page, pick["form"]["index"], plan["fills"])
                    note = _join(summarize_plan(plan, applied), lnote)
                return {"status": "queued", "reason": f"captcha; {note}", "pageUrl": url}

            attempts.append(f"{url} -> {len(scan['forms'])} form(s)")
            pick = pick_form(scan)
            if not pick:
                continue
            if pick["score"]["level"] != "high":
                fallback = fallback or {"pageUrl": url, "reason": pick["score"]["reason"]}
                continue
            return self.submit_pick(page, pick, url, entry, scan.get("lang"))

        if fallback:
            return {"status": "queued", "reason": fallback["reason"], "pageUrl": fallback["pageUrl"]}
        if scan_error:
            return {"status": "queued", "reason": f"scan-error: {scan_error}", "pageUrl": entry["url"]}
        tried = " | ".join(attempts) if attempts else "no contact links found"
        return {"status": "queued", "reason": f"no-usable-form ({tried})", "pageUrl": entry["url"]}

    def submit_pick(self, page, pick, page_url, entry, lang):
        profile, lnote = translate_profile(page, self.profile, entry["host"], lang)
        plan = build_fill_plan(pick["form"], profile, entry["host"])
        applied = self.fill(page, pick["form"]["index"], plan["fills"])
        summary = _join(summarize_plan(plan, applied), lnote)

        if self.dry_run:
            return {"status": "skipped", "reason": f"dry-run; {summary}", "pageUrl": page_url}

        # Rate limit: wait for the gap, never skip.
        while True:
            if self.stop_requested:
                return {"status": "skipped", "reason": "stopped", "pageUrl": page_url}
            gate = can_submit(load_state(self.files["state"]), now(), self.opts["gap_seconds"], self.opts["daily_cap"])
            if gate["ok"]:
                break
            if gate["reason"] == "daily-cap":
                return {"status": "skipped", "reason": "daily-cap", "pageUrl": page_url}
            time.sleep(min(gate["wait"], 5))

        low, high = self.opts["random_delay_seconds"]
        time.sleep(random.uniform(low, high))

        before = page.url
        try:
            result = page.evaluate("async ([i, u]) => await window.__fillHero.submit(i, u)", [pick["form"]["index"], before])
        except PlaywrightError:
            result = {"outcome": "confirmed"}  # the page navigated away during submit
        confirmed = result.get("outcome") == "confirmed" or page.url != before
        save_state(self.files["state"], record_submit(load_state(self.files["state"]), now()))
        return {"status": "sent" if confirmed else "sent?", "reason": summary, "pageUrl": page_url}

    # ---------- queue ----------

    def queue_add(self, host, url, reason, page_url):
        queue = [q for q in load_json(self.files["queue"], []) if q["host"] != host]
        queue.append({"host": host, "url": url, "reason": reason, "pageUrl": page_url})
        save_json(self.files["queue"], queue)

    def queue_remove(self, host):
        save_json(self.files["queue"], [q for q in load_json(self.files["queue"], []) if q["host"] != host])

    # ---------- commands ----------

    def run(self):
        entries = parse_domain_list(self.domains)
        say(f"Domains: {len(entries)}   dry run: {self.dry_run}   headless: {self.headless}")
        try:
            with sync_playwright() as pw:
                ctx = self.open_context(pw, self.headless)
                try:
                    for entry in entries:
                        if self.stop_requested:
                            break
                        self.run_one(ctx, entry)
                finally:
                    ctx.close()
        except KeyboardInterrupt:
            say("Stopped by user. Progress is saved in the log.")
        say("Done.")

    def run_one(self, ctx, entry):
        log = self.files["log"]
        if not entry["ok"]:
            append_log(log, entry["input"], "failed", entry["reason"])
            say(f"  {entry['input']}: failed ({entry['reason']})")
            return
        if already_sent(log, entry["host"]):
            append_log(log, entry["host"], "skipped", "already-sent", entry["url"])
            say(f"  {entry['host']}: skipped (already sent)")
            return

        page = self.open_page(ctx)
        keep = self.dry_run  # dry-run pages stay open for review
        try:
            result = self.process_domain(page, entry)
            if result["status"] == "queued":
                self.queue_add(entry["host"], entry["url"], result["reason"], result["pageUrl"])
                keep = True
            elif result["status"] == "sent?":
                keep = True  # unverified: leave it for a look
            append_log(log, entry["host"], result["status"], result["reason"], result.get("pageUrl", ""))
            say(f"  {entry['host']}: {result['status']}  {result['reason']}")
        except Exception as err:  # log it and carry on with the next domain
            message = str(err).splitlines()[0] if str(err) else type(err).__name__
            append_log(log, entry["host"], "failed", message, entry["url"])
            say(f"  {entry['host']}: failed ({message})")
        finally:
            if not keep:
                self.close_page(page)

    def review(self):
        """Open each queued page in a visible browser and fill it. You finish and submit it yourself."""
        queue = load_json(self.files["queue"], [])
        if not queue:
            say("The review queue is empty.")
            return
        with sync_playwright() as pw:
            ctx = self.open_context(pw, headless=False)
            try:
                for item in list(queue):
                    page = self.open_page(ctx)
                    try:
                        self.goto(page, item["pageUrl"])
                        scan = self.scan(page)
                        pick = pick_form(scan)
                        if not pick:
                            append_log(self.files["log"], item["host"], "failed", "form-not-found", item["pageUrl"])
                            say(f"  {item['host']}: form not found")
                        else:
                            profile, lnote = translate_profile(page, self.profile, item["host"], scan.get("lang"))
                            plan = build_fill_plan(pick["form"], profile, item["host"])
                            applied = self.fill(page, pick["form"]["index"], plan["fills"])
                            summary = _join(summarize_plan(plan, applied), lnote)
                            append_log(self.files["log"], item["host"], "filled-for-review", summary, item["pageUrl"])
                            say(f"  {item['host']}: filled for review  {summary}")
                    finally:
                        self.queue_remove(item["host"])
                    answer = input("  Solve any CAPTCHA and submit in the browser if you want, "
                                   "then press Enter for the next item (q to quit): ").strip().lower()
                    self.close_page(page)
                    if answer == "q":
                        break
            finally:
                ctx.close()
