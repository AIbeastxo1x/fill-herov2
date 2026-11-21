# Fill Hero: hosted web app

Fill Hero finds the contact or inquiry form on each domain you give it, fills it from your
profile and message, and submits it. The work runs in a headless Chromium on a server. The
front end is a static page on Netlify.

```
Netlify (web/)  ──HTTPS + bearer token──▶  Server (server/, Docker, headless Chromium)
                                              │
                                              ├─ src/lib/*  matching, scoring, rate limits
                                              └─ src/content.js  page script (scan, fill, submit)
```

The Chrome extension lives in the `extension/` folder and still works on its own. Its matching
code and page script are copies of the ones in `src/`. Edit them in `src/`, then run
`npm run sync:extension`. A test fails if the copies are out of date.

To load the extension in Chrome: open `chrome://extensions`, turn on **Developer mode**, click
**Load unpacked**, and choose the `extension` folder. If you loaded it from the project root
before, remove that entry first.

## Safety rules (built in)

- **Dry run is the default.** A live run needs the box unticked and an explicit confirmation.
- **A domain already sent to is never contacted again**, even after Clear all.
- **Gap of 25 seconds** between submissions and a **daily cap of 5000**.
- **CAPTCHA pages are never submitted.** They are filled and recorded in `captcha_domains.txt`.
- **The API needs a token.** It refuses to start without one (at least 24 characters).
- **Only the listed front-end origins** may call the API from a browser.

## 1. Run the server locally (to try it)

```powershell
npm install
npx playwright install chromium
$env:FILLHERO_TOKEN = "a-long-random-token-of-at-least-24-characters"
$env:ALLOWED_ORIGINS = "http://localhost:5173"
npm start
```

In a second window, serve the front end:

```powershell
cd web
python -m http.server 5173
```

Open http://localhost:5173, enter `http://localhost:8080` as the server address and your token,
then press Connect.

## 2. Deploy the server (Docker)

The server needs Chromium, so it can't run on Netlify. Any host that runs Docker works, for
example Render, Fly.io or a small VPS. It must have a **persistent disk** mounted at `/data`,
because the store (profile, log, sent-domain list) lives there.

Build and run the image:

```bash
docker build -t fill-hero-server .
docker run -p 8080:8080 \
  -e FILLHERO_TOKEN="your-long-random-token" \
  -e ALLOWED_ORIGINS="https://YOUR-SITE.netlify.app" \
  -v fillhero-data:/data \
  fill-hero-server
```

Set the same three things on your host: `FILLHERO_TOKEN`, `ALLOWED_ORIGINS`, and the disk at
`/data`. The Playwright tag in the `Dockerfile` must match the `playwright` version in
`package.json`. Check the tag exists before the first build.

Generate a token with:

```powershell
$b = New-Object byte[] 36; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
```

## 3. Deploy the front end (Netlify)

1. Deploy the project to Netlify. `netlify.toml` publishes the `web/` folder, and the
   `netlify/functions/` folder runs the sign-in and the proxy to the server.
2. In Netlify, go to **Site configuration → Environment variables** and add:
   - `FILLHERO_SERVER_URL`: your server address, for example `https://fill-herov2.onrender.com`.
   - `FILLHERO_TOKEN`: the same token as on the server.
   - `SITE_PASSWORD`: the password you will type to sign in to the page. Choose a long one.
3. Redeploy the site so the variables take effect.

The page asks for `SITE_PASSWORD`. The server token stays inside Netlify's functions and is
never sent to the browser. `ALLOWED_ORIGINS` on the server is no longer needed for the page.

## Files and downloads

- `extractedemails.txt`: every unique address found on sites with no usable form.
- `captcha_domains.txt`: domains stopped by a CAPTCHA.
- The log is kept on the server and is not shown in the page, as in the extension.
- **Live view:** during a run, the page shows each step (opened, filled, waiting for the gap,
  submitted or not) with the latest screenshot from the headless browser. This is kept in the
  server's memory only and is cleared when the next run starts, because a screenshot can show
  what was typed into a form.

## Limits to know

- **No CAPTCHA solving.** These sites are recorded for manual handling.
- **No review queue in the hosted version.** Forms that need a person are filled and listed.
- **Translation** uses the browser's built-in Translator API when Chromium has it. Otherwise
  messages go out in English, and the log says so.
- **Dates** use the server's time zone. Set `TZ` on the host if you want your local day.

## Protected extension build

Build the copy you give to customers with:

```powershell
npm run build:extension
```

This writes `dist/extension`. The background script is bundled into one file and obfuscated,
and so are the popup and page scripts. The names of the licence check and the run logic are
hidden. The readable source in `extension/` is never shipped, and `dist/` is not in git.

Zip the `dist/extension` folder for a customer, or load it unpacked to test.

The build prints a **fingerprint**: a SHA-256 of the shipped scripts. The extension sends it with
its key, and the server answers only for fingerprints listed in `APPROVED_BUILDS`. So:

1. Run `npm run build:extension` and copy the fingerprint it prints.
2. On Render, set `APPROVED_BUILDS` to the fingerprint(s) of the builds you ship (comma-separated).
3. Redeploy Render. A copy whose scripts were edited is then refused by the server.

The fingerprint changes whenever the source changes, so approve each new build before you ship it.
If `APPROVED_BUILDS` is empty, the server accepts any build.

What this does not cover: a copy with the licence check removed never contacts the server, so
the server cannot see it. Only a copy that keeps the check and changes the scripts is refused.

Obfuscation makes the code hard to read and copy, but it cannot stop a determined person who
can run the extension. Use it together with the licence check, and keep anything that must stay
private on the server.

## Extension licences

The Chrome extension needs a licence key before it runs. You issue keys in the **Extension
licences** card of the web app. Enter the customer's name, press **Issue key**, and copy the key
at once: it is shown only once, and the server keeps only a hash of it.

- The extension checks its key with the server about once a day. If the server cannot be reached,
  a key checked within the last 72 hours still works.
- **Revoke** stops a key at its next check.
- Wrong keys are limited to 30 tries per address every ten minutes.

Limit to know: the extension runs its own code on the customer's computer, so a determined person
could remove the check from a copy. The licence stops ordinary use. The web app is the part that
stays fully under your control, because it is protected by sign-in and the server token.

## Email campaign

The email campaign sends to the **consented contacts** list only. Import each list in the
**Consented contacts** card. Every import must say where and when those people agreed to be
contacted, and the tool refuses an import without both. Addresses found on websites are never
used for campaigns. It uses an SMTP relay you set up with your own provider.

Set the relay in the **Email relay (SMTP)** card on the page: host, port, login name, sender
address and password. The password is encrypted before it is saved, and the page never shows it
back. Use **Send test to my sender address** to check the settings. If you change
`FILLHERO_TOKEN`, the saved password can't be read, so enter it again.

The same settings can come from the server's environment instead, used when nothing is saved
in the page: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`. Also
`EMAIL_GAP_SECONDS` (default 60) and `EMAIL_DAILY_CAP` (default 100).

Each email has a one-click unsubscribe link and the matching mail-client header. Set
`PUBLIC_BASE_URL` on the server to your Netlify site address, for example
`https://fillhero.netlify.app`, or campaigns won't start. Opting out adds the address to the
do-not-email list, and that address is never emailed again.

Safety built in: dry run is on by default, each address is emailed once (Clear all keeps this),
the do-not-email list is never sent to, every email has your name, company and postal address,
and an opt-out line. A live send needs the postal address in the sender profile and a
confirmation in the page. Only email people who have agreed to be contacted. Opt-outs are
recorded by adding the address to the do-not-email list; replies are not read automatically.

## Tests

```powershell
npm test
```

The server tests start the API, check the token and CORS rules, and run a real headless
submission against the local fixture site in `fill_hero_py/fixture`. Nothing leaves this
computer.
