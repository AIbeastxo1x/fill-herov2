// Gap between submissions and a per-local-day cap.

export function localDateString(now) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function canSubmit(state, now, limits) {
  const today = localDateString(now);
  const count = state.dailyDate === today ? state.dailyCount : 0;

  if (count >= limits.dailyCap) return { ok: false, waitMs: 0, reason: "daily-cap" };

  const elapsed = now - state.lastSubmitAt;
  if (elapsed < limits.gapMs) return { ok: false, waitMs: limits.gapMs - elapsed, reason: "gap" };

  return { ok: true, waitMs: 0 };
}

export function nextState(state, now) {
  const today = localDateString(now);
  const count = state.dailyDate === today ? state.dailyCount : 0;
  return { lastSubmitAt: now, dailyCount: count + 1, dailyDate: today };
}
