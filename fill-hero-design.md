# Fill Hero v2: Design

## Intent

A Chrome extension that works through a list of business domains the user has permission to contact (free opt-in). For each domain it finds the contact page, fills in the contact form, and submits it. It submits automatically only when confident. Anything unclear goes into a review queue for the user.

## Goals

- Load a list of domains (paste or CSV upload).
- For each domain, find the contact page and detect the contact form.
- Fill the form from a saved sender profile and a message template.
- Auto-submit forms recognized with high confidence, with rate limiting.
- Queue everything else for manual review: one click to submit or skip.
- Log every domain's outcome, and export the log as CSV.

## Non-goals

- Solving or bypassing CAPTCHAs or other bot checks. Pages with them go to the queue.
- Creating accounts, logging in, or handling passwords.
- Sending email directly, or scraping email addresses.
- Acting as a general-purpose form filler.

## Anti-goals

- Never submits a form it isn't confident about.
- Never contacts a domain that already has a "sent" entry in the log.
- Never starts running on its own. The user must press Start.
- Never reports "sent" without evidence. Unverified submissions are logged as "sent?".

## Constraints

- Chrome Extension, Manifest V3.
- Runs entirely in the user's browser. No server, no accounts. All data is stored locally.
- Plain JavaScript with no build step.

## Approaches

- **Review each form:** safest, slowest. Rejected: too slow for the volume.
- **Fully automatic:** fastest. Rejected: a misread form sends the wrong message with no check.
- **Hybrid (chosen):** auto-submit high-confidence forms, queue the rest.

## Design

### Parts

- `manifest.json`: MV3 manifest. Permissions: `tabs`, `storage`, `scripting`, `activeTab`, host permissions `<all_urls>`.
- `popup.html` / `popup.js`: control panel. Contains:
  - Domain list input (paste or CSV upload).
  - Sender profile: name, company, email, phone, and a message template with `{company}` placeholder.
  - Start / Stop buttons.
  - Live status.
  - Review queue.
  - Log view and CSV export.
- `background.js` (service worker): orchestrates. Opens tabs, enforces rate limits, persists state, and handles stop.
- `content.js`: injected into each contact page. Finds forms, scores them, fills fields, submits, and reports results.

### Per-domain flow

1. Normalize the domain to `https://` and skip it if already logged as "sent".
2. Open a background tab.
3. Find the contact page: look for links whose text matches "contact", "contact us", or "get in touch". If none, try `/contact` and `/contact-us`.
4. Find form candidates. A candidate must have an email input or a textarea. Reject forms with password fields, search forms, and newsletter-only forms (email field and no textarea).
5. Score the candidate:
   - **High confidence:** a message textarea is present, the name, email, and message fields are identified by name, id, placeholder, autocomplete, or label keywords, and no unmapped required fields remain.
   - **Low confidence:** anything else.
6. Check for CAPTCHA (reCAPTCHA, hCaptcha, Turnstile iframes or known classes). If present, queue the domain with reason "captcha".
7. High confidence: fill fields, wait a random 2–5 seconds, submit. Check for success: URL change, a thank-you message, or the form disappearing. If the result is unclear, log "sent?". On error, queue.
8. Low confidence: queue with the filled-in form preview.
9. Close the tab.

### Rate limits and caps (defaults, configurable)

- One submission per 60 seconds.
- Daily cap of 50 submissions.

### Review queue

Each queued item shows the domain, the reason it was queued, and a link to open the page. The user can click Submit (which fills and submits the form in a visible tab) or Skip.

### Log

One row per domain: domain, status (`sent`, `sent?`, `queued`, `skipped`, `failed`), reason, page URL, timestamp. Stored in `chrome.storage.local`. Exported as CSV.

## Left to the builder

- Exact detection heuristics and keyword lists. Test against a set of real contact pages.
- UI styling.
- Test strategy: a local test page with sample forms, plus a dry-run mode that fills without submitting.

## Calls I made (not yet confirmed by you)

- Vanilla JavaScript, no build step, no framework.
- Sender profile and the message template are stored locally. Nothing is sent anywhere except the contact forms.
- Defaults: 60 seconds between submissions, 50 per day.
- A dry-run mode is included.
- Sites whose forms look like multi-step wizards are queued, not submitted.

## Known limitations

- Form detection is heuristic, so some forms will be missed or misread. Those land in the queue, not in submissions.
- Some sites give no clear success signal, which is why unverified submissions are logged as "sent?".
