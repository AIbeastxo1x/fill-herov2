"""Files the run keeps: the log (CSV), the send state (JSON) and the review queue (JSON)."""
import csv
import json
import os
import time
from datetime import datetime, timezone

SENT_STATUSES = ("sent", "sent?")
LOG_COLUMNS = ["host", "status", "reason", "pageUrl", "at"]


def _ensure_parent(path):
    folder = os.path.dirname(os.path.abspath(path))
    os.makedirs(folder, exist_ok=True)


def append_log(path, host, status, reason, page_url=""):
    _ensure_parent(path)
    new_file = not os.path.exists(path)
    with open(path, "a", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=LOG_COLUMNS)
        if new_file:
            writer.writeheader()
        writer.writerow({
            "host": host,
            "status": status,
            "reason": reason,
            "pageUrl": page_url,
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        })


def read_log(path):
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def already_sent(path, host):
    return any(row["host"] == host and row["status"] in SENT_STATUSES for row in read_log(path))


def load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def save_json(path, data):
    _ensure_parent(path)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def load_state(path):
    return load_json(path, {"last_submit_at": 0, "daily_count": 0, "daily_date": ""})


def save_state(path, state):
    save_json(path, state)


def now():
    return time.time()
