"""Find contact-page URLs on the same site as a base URL."""
import re
from urllib.parse import urljoin, urldefrag, urlsplit

CONTACT_TEXT = re.compile(r"contact|get in touch", re.I)
FALLBACK_PATHS = ["/contact", "/contact-us"]


def _bare_host(host):
    return re.sub(r"^www\.", "", host.lower())


def find_contact_links(links, base_url):
    """links: list of {"href", "text"}. Returns absolute same-site contact URLs, deduplicated."""
    base = urlsplit(base_url)
    seen = set()
    out = []
    for link in links:
        if not CONTACT_TEXT.search(str(link.get("text") or "")):
            continue
        href = link.get("href") or ""
        absolute = urljoin(base_url, href)
        target = urlsplit(absolute)
        if not target.hostname or _bare_host(target.hostname) != _bare_host(base.hostname or ""):
            continue
        clean, _fragment = urldefrag(absolute)
        if clean not in seen:
            seen.add(clean)
            out.append(clean)

    if out:
        return out
    origin = f"{base.scheme}://{base.netloc}"
    return [origin + path for path in FALLBACK_PATHS]
