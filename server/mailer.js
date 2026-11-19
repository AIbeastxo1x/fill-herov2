// SMTP relay for the email campaign.
// Settings come from the web page (saved in the store) and fall back to environment variables:
//   SMTP_HOST, SMTP_PORT (default 587; 465 = implicit TLS), SMTP_USER, SMTP_PASS, EMAIL_FROM
// The password saved from the page is encrypted with a key derived from FILLHERO_TOKEN,
// so store.json never holds it in plain text. If the token changes, re-enter the password.
import crypto from "node:crypto";
import nodemailer from "nodemailer";

const keyFrom = (token) => crypto.createHash("sha256").update(`smtp-password:${token}`).digest();

export function encryptSecret(plain, token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFrom(token), iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(stored, token) {
  const [iv, tag, data] = String(stored).split(".").map((s) => Buffer.from(s, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyFrom(token), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

// Works out the relay settings: saved settings first, then environment variables.
// Returns null when there is no host or sender address.
export function resolveSmtp(settings = {}, env = process.env, token = "") {
  const host = settings.host || env.SMTP_HOST || "";
  const from = settings.from || env.EMAIL_FROM || "";
  if (!host || !from) return null;
  let pass = env.SMTP_PASS || "";
  if (settings.passEnc) {
    try {
      pass = decryptSecret(settings.passEnc, token);
    } catch {
      return null; // saved password cannot be read (token changed): ask for it again
    }
  }
  return {
    host,
    port: Number(settings.port || env.SMTP_PORT || 587),
    user: settings.user || env.SMTP_USER || "",
    pass,
    from,
    source: settings.host ? "settings" : "environment",
  };
}

// Builds a mailer from resolved settings: { from, send(message) }.
export function mailerFromSettings(smtp) {
  if (!smtp) return null;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
  return { from: smtp.from, send: (message) => transport.sendMail(message) };
}

// Returns a function that gives the current mailer. It rebuilds the transport only when the
// settings change, so it is cheap to call on every status check.
export function makeMailerSource(store, { env = process.env, token = "" } = {}) {
  let cacheKey = null;
  let cached = null;
  return () => {
    const s = store.get().smtp || {};
    const key = JSON.stringify([s.host, s.port, s.user, s.from, s.passEnc, env.SMTP_HOST, env.SMTP_PORT, env.SMTP_USER, env.SMTP_PASS, env.EMAIL_FROM]);
    if (key !== cacheKey) {
      cacheKey = key;
      cached = mailerFromSettings(resolveSmtp(s, env, token));
    }
    return cached;
  };
}
