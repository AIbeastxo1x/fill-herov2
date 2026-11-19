"""Gap between submissions and a per-local-day cap."""
import time


def local_date(now):
    return time.strftime("%Y-%m-%d", time.localtime(now))


def can_submit(state, now, gap_seconds, daily_cap):
    """state: {"last_submit_at", "daily_count", "daily_date"} (seconds since epoch).
    Returns {"ok": bool, "wait": seconds, "reason": str}."""
    today = local_date(now)
    count = state.get("daily_count", 0) if state.get("daily_date") == today else 0
    if count >= daily_cap:
        return {"ok": False, "wait": 0, "reason": "daily-cap"}
    elapsed = now - state.get("last_submit_at", 0)
    if elapsed < gap_seconds:
        return {"ok": False, "wait": gap_seconds - elapsed, "reason": "gap"}
    return {"ok": True, "wait": 0, "reason": ""}


def record_submit(state, now):
    today = local_date(now)
    count = state.get("daily_count", 0) if state.get("daily_date") == today else 0
    return {"last_submit_at": now, "daily_count": count + 1, "daily_date": today}
