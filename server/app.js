// The HTTP API. Every /api route except /api/health needs the bearer token.
// The Netlify front end calls it from another origin, so only ALLOWED_ORIGINS get CORS access.
import crypto from "node:crypto";
import express from "express";
import { DEFAULT_PROFILE } from "./store.js";
import { LIMITS } from "./engine.js";
import { parseDomainList } from "../src/lib/normalize.js";
import { buildEmailsFile, buildCaptchaFile } from "../src/lib/files.js";

const PROFILE_KEYS = Object.keys(DEFAULT_PROFILE);
const MAX_FIELD = 500;
const MAX_TEMPLATE = 5000;
const MAX_DOMAINS = 5000;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Keeps only known profile keys and checks each one is text of a sensible length.
export function cleanProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError(400, "profile must be an object");
  const out = {};
  for (const key of PROFILE_KEYS) {
    const value = input[key] ?? DEFAULT_PROFILE[key];
    if (typeof value !== "string") throw httpError(400, `${key} must be text`);
    if (value.length > (key === "template" ? MAX_TEMPLATE : MAX_FIELD)) throw httpError(400, `${key} is too long`);
    out[key] = value;
  }
  return out;
}

function localDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function summarize(s) {
  const counts = {};
  for (const e of s.log) counts[e.status] = (counts[e.status] ?? 0) + 1;
  return {
    sent: (counts.sent ?? 0) + (counts["sent?"] ?? 0),
    filledForReview: counts["filled-for-review"] ?? 0,
    queued: counts.queued ?? 0,
    skipped: counts.skipped ?? 0,
    failed: counts.failed ?? 0,
    totalEntries: s.log.length,
  };
}

export function createApp({ store, engine, token, origins = [] }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "300kb" }));

  // CORS: only the listed front-end origins may call the API from a browser.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.get("/api/health", (req, res) => res.json({ ok: true }));

  const expected = Buffer.from(token);
  app.use("/api", (req, res, next) => {
    const header = req.headers.authorization || "";
    const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
    res.status(401).json({ error: "unauthorized" });
  });

  app.get("/api/state", (req, res) => {
    const s = store.get();
    const today = localDate();
    res.json({
      running: engine.running,
      dryRun: s.dryRun,
      profile: { ...DEFAULT_PROFILE, ...s.profile },
      summary: summarize(s),
      dailyCount: s.dailyDate === today ? s.dailyCount : 0,
      dailyDate: s.dailyDate,
      dailyCap: LIMITS.dailyCap,
      gapSeconds: LIMITS.gapMs / 1000,
      sentDomains: s.sentHosts.length,
      emailCount: new Set(s.emails.map((e) => e.email)).size,
      captchaCount: s.captchaDomains.length,
      queueCount: s.queue.length,
    });
  });

  app.put("/api/profile", (req, res) => {
    store.set({ profile: cleanProfile(req.body) });
    res.json({ ok: true });
  });

  app.post("/api/start", (req, res, next) => {
    try {
      const { domains, dryRun } = req.body ?? {};
      if (typeof domains !== "string") throw httpError(400, "domains must be text");
      const list = parseDomainList(domains);
      if (list.length === 0) throw httpError(400, "no domains given");
      if (list.length > MAX_DOMAINS) throw httpError(400, `at most ${MAX_DOMAINS} domains per run`);
      if (engine.running) throw httpError(409, "already-running");
      // Only an explicit false starts a live run. Anything else is a dry run.
      engine.start(list, { dryRun: dryRun !== false });
      res.status(202).json({ ok: true, domains: list.length, dryRun: dryRun !== false });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/stop", (req, res) => {
    engine.stop();
    res.json({ ok: true });
  });

  app.post("/api/clear", (req, res, next) => {
    if (engine.running) return next(httpError(409, "stop-the-run-first"));
    // Clears the working data. sentHosts is kept, so a sent domain is never contacted again.
    store.set({ log: [], queue: [], emails: [], captchaDomains: [] });
    res.json({ ok: true });
  });

  app.get("/api/files/emails.txt", (req, res) => {
    res.type("text/plain; charset=utf-8");
    res.attachment("extractedemails.txt");
    res.send(buildEmailsFile(store.get().emails));
  });

  app.get("/api/files/captcha_domains.txt", (req, res) => {
    res.type("text/plain; charset=utf-8");
    res.attachment("captcha_domains.txt");
    res.send(buildCaptchaFile(store.get().captchaDomains));
  });

  // Errors: a known status from httpError, otherwise 500 without internal details.
  app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "invalid JSON" });
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "server error" });
  });

  return app;
}
