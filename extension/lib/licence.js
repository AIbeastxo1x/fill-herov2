// Decides whether the extension may run. Pure logic, so it can be tested without a browser.
// The extension asks the server about its key at most once a day. If the server cannot be reached,
// a key that was valid within the last 72 hours still works (so a network blip does not stop work).
// A key with an expiry date stops working on that date, whatever the check says.
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
export const GRACE_MS = 72 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

// expiresAt is a timestamp in milliseconds, or null for a key with no expiry.
export function isExpired(expiresAt, now) {
  return Boolean(expiresAt) && now >= expiresAt;
}

// Whole days left, rounded up, or null when the key has no expiry.
export function daysLeft(expiresAt, now) {
  if (!expiresAt) return null;
  return Math.max(0, Math.ceil((expiresAt - now) / DAY_MS));
}

// cache: { key, checkedAt, valid, customer, expiresAt } from the last check, or null.
// Returns true when the server should be asked again.
export function needsCheck(cache, now) {
  if (!cache || !cache.key || !cache.valid) return true;
  if (isExpired(cache.expiresAt, now)) return true;
  return now - (cache.checkedAt || 0) >= CHECK_EVERY_MS;
}

// serverAnswer: { valid, customer, expiresAt, reason } from the server, or null when it could not be reached.
// Returns { allowed, reason, cache } where cache is what to store for next time.
export function decide(cache, key, now, serverAnswer) {
  if (!key) return { allowed: false, reason: "no-licence", cache: null };

  if (serverAnswer) {
    if (serverAnswer.valid) {
      if (isExpired(serverAnswer.expiresAt, now)) {
        return { allowed: false, reason: "expired", cache: { key, checkedAt: now, valid: false, customer: "", expiresAt: null } };
      }
      const next = {
        key,
        checkedAt: now,
        valid: true,
        customer: serverAnswer.customer || "",
        expiresAt: serverAnswer.expiresAt ?? null,
      };
      return { allowed: true, reason: "valid", cache: next };
    }
    // The server's reason (for example "build-not-approved" or "expired") is passed on so the popup can explain it.
    return {
      allowed: false,
      reason: serverAnswer.reason || "licence-not-valid",
      cache: { key, checkedAt: now, valid: false, customer: "", expiresAt: null },
    };
  }

  // No answer from the server: allowed only inside the grace period of a key that was valid and has not expired.
  const sameKey = cache && cache.key === key;
  if (sameKey && cache.valid && now - (cache.checkedAt || 0) < GRACE_MS && !isExpired(cache.expiresAt, now)) {
    return { allowed: true, reason: "offline-grace", cache };
  }
  if (sameKey && isExpired(cache.expiresAt, now)) {
    return { allowed: false, reason: "expired", cache };
  }
  return { allowed: false, reason: "cannot-check-licence", cache: sameKey ? cache : null };
}
