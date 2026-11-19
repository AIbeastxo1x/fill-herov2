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

The Chrome extension in the same project is unchanged. It still works on its own.

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

## Limits to know

- **No CAPTCHA solving.** These sites are recorded for manual handling.
- **No review queue in the hosted version.** Forms that need a person are filled and listed.
- **Translation** uses the browser's built-in Translator API when Chromium has it. Otherwise
  messages go out in English, and the log says so.
- **Dates** use the server's time zone. Set `TZ` on the host if you want your local day.

## Email campaign

The email card sends one inquiry email to each address the domain run extracted. It uses an
SMTP relay you set up with your own provider.

Set the relay in the **Email relay (SMTP)** card on the page: host, port, login name, sender
address and password. The password is encrypted before it is saved, and the page never shows it
back. Use **Send test to my sender address** to check the settings. If you change
`FILLHERO_TOKEN`, the saved password can't be read, so enter it again.

The same settings can come from the server's environment instead, used when nothing is saved
in the page: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`. Also
`EMAIL_GAP_SECONDS` (default 60) and `EMAIL_DAILY_CAP` (default 100).

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
