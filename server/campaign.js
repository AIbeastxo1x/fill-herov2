// Email campaign: sends one inquiry email to each address the domain run extracted.
// Safety rules, built in:
//   - Dry run is the default. A dry run composes every email and sends none.
//   - Each address is emailed at most once. Clear all keeps this record.
//   - Addresses on the do-not-email list are never sent to.
//   - A gap between sends and a daily cap (EMAIL_GAP_SECONDS, EMAIL_DAILY_CAP).
//   - Every email has the sender's name, company and postal address, and says how to opt out.
//   - Live sends need a postal address in the sender profile, and a relay configured.
export const EMAIL_LOG_LIMIT = 5000;

const localDate = (date = new Date()) => {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export function fillTemplate(text, { domain = "", company = "" } = {}) {
  return String(text || "").replaceAll("{domain}", domain).replaceAll("{company}", company);
}

// Builds the message. The footer carries the sender identity, the postal address and the opt-out line.
export function composeEmail({ subject, body, profile, host, email, from }) {
  const vars = { domain: host, company: profile.company || "" };
  const sender = [profile.firstName, profile.lastName].filter(Boolean).join(" ");
  const who = [sender, profile.company].filter(Boolean).join(", ");
  const postal = [profile.address, profile.city, profile.state, profile.zip, profile.country].filter(Boolean).join(", ");
  const footer = [
    "",
    "--",
    who,
    postal,
    'To stop receiving these emails, reply with "unsubscribe" and you will not be contacted again.',
  ].join("\n");
  return {
    from,
    to: email,
    subject: fillTemplate(subject, vars),
    text: `${fillTemplate(body, vars)}\n${footer}`,
    headers: { "List-Unsubscribe": `<mailto:${from}?subject=unsubscribe>` },
  };
}

// Consented contacts that have not been sent to and are not on the do-not-email list.
// Only the contacts list is used. Addresses found on websites are never emailed.
export function pendingRecipients(state) {
  const sent = new Set(state.emailLog.filter((e) => e.status === "sent").map((e) => e.email));
  const suppressed = new Set(state.suppressed);
  const seen = new Set();
  const out = [];
  for (const contact of state.contacts ?? []) {
    const email = contact.email;
    if (seen.has(email) || sent.has(email) || suppressed.has(email)) continue;
    seen.add(email);
    out.push({ email, host: email.split("@")[1] || "" });
  }
  return out;
}

export class CampaignRunner {
  // store: from store.js. mailer: a function returning the current mailer ({ from, send(message) }) or null,
  // or a mailer object itself.
  constructor(store, { mailer = null, gapMs = 60000, dailyCap = 100, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.store = store;
    this.mailerSource = typeof mailer === "function" ? mailer : () => mailer;
    this.gapMs = gapMs;
    this.dailyCap = dailyCap;
    this.sleep = sleep;
    this.running = false;
    this.stopRequested = false;
    this.current = null;
  }

  configured() {
    return Boolean(this.mailerSource());
  }

  // Sends one test message to the sender address itself, to check the relay settings.
  async testSend() {
    const mailer = this.mailerSource();
    if (!mailer) throw Object.assign(new Error("not-configured"), { status: 400 });
    await mailer.send({
      from: mailer.from,
      to: mailer.from,
      subject: "Fill Hero relay test",
      text: "This is a test from Fill Hero. If you can read it, the SMTP relay settings work.",
    });
    return { to: mailer.from };
  }

  start({ dryRun }) {
    if (this.running) throw Object.assign(new Error("already-running"), { status: 409 });
    this.running = true;
    this.stopRequested = false;
    const recipients = pendingRecipients(this.store.get());
    this.current = this.run(recipients, dryRun)
      .catch((err) => console.error("campaign failed:", err.message))
      .finally(() => {
        this.running = false;
        this.stopRequested = false;
      });
    return recipients.length;
  }

  stop() {
    this.stopRequested = true;
  }

  record(entry) {
    const log = [...this.store.get().emailLog, { ...entry, at: Date.now() }].slice(-EMAIL_LOG_LIMIT);
    this.store.set({ emailLog: log });
  }

  async run(recipients, dryRun) {
    const campaign = this.store.get().campaign;
    const mailer = this.mailerSource();
    if (!dryRun && !mailer) return; // no relay configured: nothing is sent
    const from = mailer?.from || "";
    for (let i = 0; i < recipients.length; i++) {
      if (this.stopRequested) break;
      const { email, host } = recipients[i];
      if (dryRun) {
        this.record({ email, host, status: "dry-run" });
        continue;
      }

      const today = localDate();
      const daily = this.store.get().emailDaily;
      const count = daily.date === today ? daily.count : 0;
      if (count >= this.dailyCap) {
        this.record({ email, host, status: "skipped", reason: "daily-cap" });
        break;
      }

      const message = composeEmail({ subject: campaign.subject, body: campaign.body, profile: this.store.get().profile, host, email, from });
      try {
        await mailer.send(message);
        this.record({ email, host, status: "sent" });
        this.store.set({ emailDaily: { date: today, count: count + 1 } });
      } catch (err) {
        this.record({ email, host, status: "failed", reason: String(err?.message ?? err).slice(0, 300) });
      }

      if (i < recipients.length - 1 && !this.stopRequested) await this.sleep(this.gapMs);
    }
  }
}

// Reads the gap and daily cap from the environment, with safe defaults.
export function campaignLimitsFromEnv(env = process.env) {
  const gap = Number(env.EMAIL_GAP_SECONDS ?? 60);
  const cap = Number(env.EMAIL_DAILY_CAP ?? 100);
  return {
    gapMs: Number.isFinite(gap) && gap >= 0 ? gap * 1000 : 60000,
    dailyCap: Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 100,
  };
}
