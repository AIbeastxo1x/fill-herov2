"""Turn user-entered domains into https URLs and hostnames."""
import re
from urllib.parse import urlsplit


def normalize_domain(raw):
    """Return {"ok": True, "url", "host"} or {"ok": False, "reason"}."""
    text = str(raw or "").strip()
    if not text:
        return {"ok": False, "reason": "empty"}

    with_scheme = text if re.match(r"^https?://", text, re.I) else f"https://{text}"
    try:
        parts = urlsplit(with_scheme)
        host = (parts.hostname or "").lower()
        port = parts.port  # raises ValueError for a bad port
    except ValueError:
        return {"ok": False, "reason": "invalid-url"}

    if not host:
        return {"ok": False, "reason": "no-host"}

    # Local test servers keep their scheme and port; real domains always use https.
    if host in ("localhost", "127.0.0.1"):
        scheme = parts.scheme.lower()
        netloc = f"{host}:{port}" if port else host
        return {"ok": True, "url": f"{scheme}://{netloc}/", "host": netloc}

    if "." not in host:
        return {"ok": False, "reason": "no-host"}
    return {"ok": True, "url": f"https://{host}/", "host": host}


def parse_domain_list(items):
    """Accept a list of strings, or one string split on newlines and commas."""
    if isinstance(items, str):
        items = re.split(r"[\n,]", items)
    out = []
    for item in items:
        text = str(item).strip()
        if not text:
            continue
        r = normalize_domain(text)
        if r["ok"]:
            out.append({"input": text, "ok": True, "url": r["url"], "host": r["host"]})
        else:
            out.append({"input": text, "ok": False, "reason": r["reason"]})
    return out
