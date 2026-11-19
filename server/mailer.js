// SMTP relay for the email campaign. Configured with environment variables:
//   SMTP_HOST      relay host, for example smtp.your-provider.com (required to send)
//   SMTP_PORT      default 587 (STARTTLS). Use 465 for implicit TLS.
//   SMTP_USER      relay login, if the relay needs one
//   SMTP_PASS      relay password or API key. Keep it in the host's secret settings only.
//   EMAIL_FROM     the sender address your relay has verified, for example outreach@your-domain.com
import nodemailer from "nodemailer";

// Returns { from, send(message) } when SMTP_HOST and EMAIL_FROM are set, otherwise null.
export function mailerFromEnv(env = process.env) {
  if (!env.SMTP_HOST || !env.EMAIL_FROM) return null;
  const port = Number(env.SMTP_PORT || 587);
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS || "" } : undefined,
  });
  return {
    from: env.EMAIL_FROM,
    send: (message) => transport.sendMail(message),
  };
}
