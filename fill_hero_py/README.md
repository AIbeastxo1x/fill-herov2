# Fill Hero (Python)

Fills contact forms on opted-in business websites with a Chromium browser that Playwright
installs for you. Settings, the domain list and file locations are kept in `settings.json`.

## Setup

```bash
python -m pip install -r requirements.txt
python -m playwright install chromium
```

## Use

Start with a dry run. It fills each form and never submits.

```bash
python fill_hero.py run --settings settings.json --dry-run
```

When the fills look right, run live:

```bash
python fill_hero.py run --settings settings.json --live
```

Forms that can't be submitted automatically go to a review queue. Open them in a visible
browser, check them, and finish them yourself:

```bash
python fill_hero.py review --settings settings.json
```

## Settings

- Domains: put one domain or contact-page URL per line in `domains.txt`. Lines starting with `#`
  are ignored. If `domains.txt` doesn't exist, the `domains` list in `settings.json` is used.
- `profile`: your name, company, email, phone, subject, job title, country and address.
- Message: write the message in `message.txt`. Use `{domain}` for the target domain and
  `{company}` for your company. If `message.txt` doesn't exist, the `template` in `profile` is used.
- `run`:
  - `dry_run`: true means fill but never submit.
  - `gap_seconds`: minimum time between two submissions (default 60).
  - `daily_cap`: maximum submissions per day (default 50).
  - `max_tabs`: maximum pages open at once (default 5).
  - `max_contact_pages`: contact pages checked per domain (default 3).
  - `random_delay_seconds`: a random pause before each submit.
- `files`: where the log (`log.csv`), send state (`state.json`), review queue (`queue.json`)
  and browser profile are kept. Relative paths are relative to the settings file.

## Safety rules

- A form is submitted only when every field is recognised and the form is not behind a CAPTCHA.
  The tool never solves or bypasses CAPTCHAs.
- A form behind a CAPTCHA, or with fields it can't match, is filled and queued for review.
- A domain already logged as `sent` is never contacted again.
- Submissions are spaced by `gap_seconds` and capped by `daily_cap`.
- Pages open at most `max_tabs` at a time, and a page closes after its form is sent.
- The message is translated only with Chromium's built-in translator, so the text is not sent
  to an outside service. If that translator isn't available, the message goes out in English and
  the log says so.

## Files

- `fill_hero.py`: entry point.
- `fillhero/`: the package. `matching.py` decides which fields to fill, `runner.py` drives the
  browser, `content.js` is the page-side script, and `store.py` writes the log and state.
- `tests/`: unit tests. Run with `python -m unittest discover -s tests -t .`
