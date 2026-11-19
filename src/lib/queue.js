// Log helpers. Pure functions over arrays of log entries.

export const SENT_STATUSES = ["sent", "sent?"];

export function addLog(log, entry) {
  return [...log, { ...entry }];
}

export function hasSent(log, host) {
  return log.some((e) => e.host === host && SENT_STATUSES.includes(e.status));
}

export function logToCsv(log) {
  const cols = ["host", "status", "reason", "pageUrl", "at"];
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = log.map((e) => cols.map((c) => esc(c === "at" ? new Date(e.at).toISOString() : e[c])).join(","));
  return [cols.join(","), ...rows].join("\n");
}
