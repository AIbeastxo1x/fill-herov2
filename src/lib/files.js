// Builds the plain-text files the extension saves. Pure functions, so they can be unit tested.
// Chrome saves them under the Downloads folder, inside a FillHero subfolder.

export const FILES_FOLDER = "FillHero";
export const EMAIL_FILE = `${FILES_FOLDER}/extractedemails.txt`;
export const CAPTCHA_FILE = `${FILES_FOLDER}/captcha_domains.txt`;

// One unique address per line, sorted, with the first site it was found on.
export function buildEmailsFile(emails, now = Date.now()) {
  const unique = new Map();
  for (const e of emails) if (!unique.has(e.email)) unique.set(e.email, e.host);
  const sorted = [...unique].sort(([a], [b]) => a.localeCompare(b));
  return textFile(
    ["# Fill Hero - extracted email addresses", `# ${sorted.length} unique address(es), updated ${new Date(now).toISOString()}`, "", ...sorted.map(([email, host]) => `${email}\t${host}`)]
  );
}

// One domain per line, with the page it was blocked on and when.
export function buildCaptchaFile(items, now = Date.now()) {
  const sorted = [...items].sort((a, b) => a.host.localeCompare(b.host));
  return textFile(
    [
      "# Fill Hero - domains stopped by a CAPTCHA (filled, not submitted)",
      `# ${sorted.length} domain(s), updated ${new Date(now).toISOString()}`,
      "",
      ...sorted.map((i) => `${i.host}\t${i.pageUrl}\t${new Date(i.at).toISOString()}`),
    ]
  );
}

export function dataUrl(text, mime = "text/plain") {
  return `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;
}

function textFile(lines) {
  return lines.join("\r\n") + "\r\n";
}
