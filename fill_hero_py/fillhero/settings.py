"""Load settings.json: domains, sender profile, run options and file locations."""
import json
import os

DEFAULT_PROFILE = {
    "firstName": "", "lastName": "", "company": "", "email": "", "phone": "",
    "subject": "", "jobTitle": "", "country": "", "address": "",
    "template": "Hello {domain} team,\n\n",
}

DEFAULT_RUN = {
    "dry_run": True,            # fill but never submit, until this is set to false
    "headless": False,          # False shows the browser window
    "gap_seconds": 60,          # minimum time between two submissions
    "daily_cap": 50,            # maximum submissions per local day
    "max_tabs": 5,              # maximum pages open at once
    "max_contact_pages": 3,     # contact pages checked per domain
    "page_timeout_seconds": 20,
    "random_delay_seconds": [2, 5],
}

DEFAULT_FILES = {
    "domains": "domains.txt",
    "message": "message.txt",
    "log": "output/log.csv",
    "state": "output/state.json",
    "queue": "output/queue.json",
    "browser_profile": "output/browser-profile",
}


def read_message_file(path):
    """The whole file is the message. Use {domain} and {company} as placeholders."""
    with open(path, encoding="utf-8-sig") as fh:
        return fh.read().rstrip()


def read_domains_file(path):
    """One domain per line. Blank lines and lines starting with # are ignored."""
    with open(path, encoding="utf-8-sig") as fh:
        return [line.strip() for line in fh if line.strip() and not line.strip().startswith("#")]


def load_settings(path):
    """Returns {"domains", "profile", "run", "files"}. File paths are relative to the settings file."""
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)

    base = os.path.dirname(os.path.abspath(path))
    profile = {**DEFAULT_PROFILE, **raw.get("profile", {})}
    run = {**DEFAULT_RUN, **raw.get("run", {})}
    files = {k: os.path.normpath(os.path.join(base, v)) for k, v in {**DEFAULT_FILES, **raw.get("files", {})}.items()}

    # message.txt holds the message template. If it does not exist, profile.template is used.
    if os.path.exists(files["message"]):
        profile["template"] = read_message_file(files["message"])

    # domains.txt is the domain list. If it does not exist, the "domains" list in settings is used.
    if os.path.exists(files["domains"]):
        domains = read_domains_file(files["domains"])
    else:
        domains = raw.get("domains", [])
        if not isinstance(domains, list):
            raise ValueError('"domains" must be a list of domain names')
    return {"domains": domains, "profile": profile, "run": run, "files": files}
