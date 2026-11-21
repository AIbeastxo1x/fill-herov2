# Test harness

This document says how Fill Hero is tested, what a passing run means, and what must be checked
before a live run. Read it before changing code, and update it when you add a test layer.

## Quick start

```powershell
npm install
npx playwright install chromium   # needed once, for the live browser tests
npm test
```

A passing run ends with `ℹ fail 0`. Anything else is a failure, and nothing ships until it passes.

## Standard

- **Pass rate: 100%.** No skipped or flaky tests are accepted. A test that fails sometimes is a bug
  to fix, not a test to rerun.
- **No real sites.** Every test uses local servers, the local fixture in `fill_hero_py/fixture`, or a
  fake browser. No test contacts a business, sends an email or submits a form.
- **No real mail.** The campaign and relay tests use a fake transport that records messages.
- **No hangs.** Every test must finish. Browser steps have time limits, and the tests use short limits
  so a hang shows up as a failure in seconds, not minutes.
- **Tests run offline** apart from the local servers and the headless browser.

## Layers

| Layer | Files | What it proves |
| --- | --- | --- |
| Pure logic | `normalize`, `score`, `fieldMap`, `addressFields`, `fillPlan`, `contactLinks`, `language`, `rateLimit`, `queue`, `emails`, `files` | Matching, scoring, rate limits, file formats |
| Form fixtures | `fixtures.test.js` | Scoring on forms captured from real pages |
| Server API | `functions`, `server`, `smtp`, `contacts`, `campaign`, `unsubscribe` | Sign-in, token checks, routes, validation, campaign safety rules, unsubscribe links |
| Live browser | `server.test.js` | A real headless Chromium fills and submits the local fixture form, checks the sent-domain rule, dry-run behaviour, the live view, and the file downloads |
| Extension structure | `extension.test.js` | The copies in `extension/` match `src/`, and every file the manifest names exists |
| Extension run | `extension-run.test.js` | The real service worker runs against a simulated Chrome: hanging pages, the domain limit, Stop, and the history watchdog |

The extension run tests use a fake browser. They cannot prove real Chrome behaves the same way,
so a manual dry run in Chrome is still required (see the checklist below).

## What each run must cover

Any change to these areas needs a test that fails without the change:

- **Sent-domain rule:** a domain already sent to is never contacted again, even after Clear all.
- **Dry run default:** a run is a dry run unless the request explicitly says otherwise.
- **Consent:** campaign emails go only to consented contacts, and every import records a source and date.
- **Do-not-email:** suppressed addresses are never sent to, and unsubscribe links work and cannot be forged.
- **Limits:** the gap between submissions, the daily cap and the whole-domain time limit.
- **Timeouts:** a page that never responds is given up on; a timed-out submit is never recorded as a clean send.
- **Authentication:** every API route refuses requests without a valid sign-in or token.
- **No CAPTCHA solving:** CAPTCHA pages are filled, recorded and never submitted.

## Adding a test

1. Put it in the layer that matches what it proves (see the table).
2. Use `node:test` and `node:assert/strict`, as the existing files do.
3. Use a temporary store (`mkdtempSync`) and a random port (`listen(0)`), so tests never share state.
4. For anything that would send mail or submit a form, use a fake transport or the local fixture only.
5. Run `npm test` and confirm the new test fails when the behaviour it checks is broken.

## Before a live run (manual checklist)

Automated tests cannot see a real business site, so these steps are required before any live run:

1. `npm test` passes with `fail 0`.
2. The latest code is pushed, and Render and Netlify are redeployed.
3. The extension is reloaded in Chrome and the history permission is approved, if asked.
4. A dry run on two or three domains you own or have permission to contact:
   - the Live view shows each step, and the steps finish;
   - nothing is marked `sent` in the Run report;
   - Stop ends the run within a few seconds.
5. For email campaigns: a test message to your own sender address arrives, and the unsubscribe
   link on it works.
6. Only then a live run, starting with a small list, with someone watching the Live view.

## Known gaps

- Real Chrome behaviour, and real business sites, are only checked manually (checklist above).
- The Docker image is built on Render, not tested locally by these commands.
- Browser history clean-up is tested with a fake history API, not real Chrome history.
- The Python port in `fill_hero_py/` is not part of `npm test`.

## When a test fails

1. Read the failing assertion, not just the test name.
2. Reproduce it with `node --test tests/<file>.test.js`.
3. Fix the code, not the expectation, unless the expectation was wrong. Say which in the commit message.
4. Re-run the full `npm test`, not only the failing file.
