"""Decide which fields of a contact form to fill, and report what could not be filled.

A port of the browser extension's fieldMap.js, score.js and fillPlan.js. Keep the
keyword lists in step with those files.
"""
import re

# Order matters: more specific roles are checked before the generic "name".
_KEYWORDS = [
    ("lastName", ["last name", "lastname", "surname", "family name", "nom de famille", "nachname", "apellido", "cognome", "achternaam", "sobrenome"]),
    ("name", ["full name", "fullname", "nome completo", "nombre completo", "vollständiger name"]),
    ("firstName", ["first name", "firstname", "given name", "prénom", "prenom", "vorname", "voornaam", "nombre", "nome"]),
    ("email", ["email", "e-mail", "courriel", "correo", "posta elettronica", "e-mailadres", "correio"]),
    ("phone", ["phone", "tel", "téléphone", "telephone", "teléfono", "telefono", "telefoon", "telefon"]),
    ("company", ["company", "organization", "organisation", "business", "société", "societe", "entreprise", "firma", "unternehmen", "empresa", "azienda", "bedrijf"]),
    ("subject", ["subject", "topic", "reason", "objet", "sujet", "betreff", "asunto", "oggetto", "onderwerp", "assunto"]),
    ("jobTitle", ["job title", "jobtitle", "position", "title", "poste", "cargo", "berufsbezeichnung"]),
    ("country", ["country", "pays", "país", "paese", "land"]),
    ("address", ["address", "adresse", "dirección", "indirizzo", "adres", "endereço", "street"]),
    ("message", ["message", "comment", "inquir", "enquir", "question", "details", "how can we help", "préciser", "precis", "nachricht", "mensaje", "messaggio", "bericht", "mensagem", "commentaire", "kommentar", "opmerking", "anfrage"]),
    ("name", ["name", "nom"]),
]

_HIDDEN_NAME = re.compile(r"g-recaptcha-response|h-captcha-response|honeypot|ak_hp|_hp_", re.I)

PLATFORM_HINTS = [
    ("contact-form-7", re.compile(r"wpcf7", re.I)),
    ("gravity-forms", re.compile(r"gform", re.I)),
    ("hubspot", re.compile(r"hbspt|hs-form", re.I)),
    ("wix", re.compile(r"\bwix\b|\bcomp-", re.I)),
    ("webflow", re.compile(r"w-form", re.I)),
    ("squarespace", re.compile(r"squarespace", re.I)),
]


def _normalize(text):
    return str(text or "").lower().replace("-", " ").replace("_", " ")


def _role_from_text(d):
    haystack = _normalize(" ".join(str(d.get(k) or "") for k in ("name", "id", "placeholder", "label", "autocomplete")))
    for role, words in _KEYWORDS:
        if any(_normalize(w) in haystack for w in words):
            return role
    return "unknown"


def classify_field(d):
    """d: {"tag", "type", "name", "id", "placeholder", "autocomplete", "label", "required"}."""
    typ = str(d.get("type") or "").lower()
    tag = str(d.get("tag") or "").lower()

    if typ == "hidden":
        return "hidden"
    if _HIDDEN_NAME.search(str(d.get("name") or "") + str(d.get("id") or "")):
        return "hidden"  # CAPTCHA responses and anti-spam honeypots are never filled
    if typ in ("submit", "button", "image", "reset"):
        return "submit"
    if typ in ("checkbox", "radio"):
        return "consent"
    if tag == "select":
        return _role_from_text(d)
    if tag == "textarea":
        # A textarea is a message box, except when it is clearly an address.
        return "address" if _role_from_text(d) == "address" else "message"
    if typ == "email":
        return "email"
    if typ == "tel":
        return "phone"
    return _role_from_text(d)


def score_form(form):
    """Returns {"level": "high"|"low", "reason": str, "fieldMap": {role: index}}."""
    fields = form.get("fields", [])
    roles = [classify_field(f) for f in fields]
    field_map = {}
    for i, role in enumerate(roles):
        field_map.setdefault(role, i)

    def result(level, reason):
        return {"level": level, "reason": reason, "fieldMap": field_map}

    if form.get("hasPassword"):
        return result("low", "has-password")
    if "message" not in field_map:
        return result("low", "no-message-field")
    if "email" not in field_map:
        return result("low", "no-email-field")
    if any(roles[i] == "consent" and f.get("required") for i, f in enumerate(fields)):
        return result("low", "consent-required")
    if any(f.get("required") and roles[i] == "unknown" for i, f in enumerate(fields)):
        return result("low", "unmapped-required")
    return result("high", "ok")


def pick_form(scan):
    """Best candidate form on a scanned page, or None."""
    candidates = []
    for form in scan.get("forms", []):
        score = score_form(form)
        if "message" in score["fieldMap"] or "email" in score["fieldMap"]:
            candidates.append({"form": form, "score": score})
    for c in candidates:
        if c["score"]["level"] == "high":
            return c
    return candidates[0] if candidates else None


def detect_platform(form):
    hay = f"{form.get('id') or ''} {form.get('className') or ''} {form.get('action') or ''}"
    for name, pattern in PLATFORM_HINTS:
        if pattern.search(hay):
            return name
    return "generic"


def detect_form_type(scored):
    m = scored["fieldMap"]
    has_name = any(k in m for k in ("firstName", "lastName", "name"))
    if "message" in m and "email" in m:
        return "contact" if has_name else "message-only"
    return "other"


def values_for(profile, host):
    first = profile.get("firstName") or ""
    last = profile.get("lastName") or ""
    template = profile.get("template") or ""
    company = profile.get("company") or ""
    return {
        "firstName": first,
        "lastName": last,
        "name": " ".join(x for x in (first, last) if x),
        "email": profile.get("email") or "",
        "phone": profile.get("phone") or "",
        "company": company,
        "subject": profile.get("subject") or "",
        "jobTitle": profile.get("jobTitle") or "",
        "country": profile.get("country") or "",
        "address": profile.get("address") or "",
        "message": template.replace("{domain}", host).replace("{company}", company),
    }


def build_fill_plan(form, profile, host):
    score = score_form(form)
    values = values_for(profile, host)
    fills, unfilled = [], []
    for role, index in score["fieldMap"].items():
        if role not in values:
            continue  # hidden, submit, consent, unknown
        value = values[role]
        if value:
            fills.append({"index": index, "role": role, "value": value})
        else:
            required = bool(form["fields"][index].get("required"))
            unfilled.append({"index": index, "role": role, "reason": "profile-empty", "required": required})
    return {
        "score": score,
        "type": detect_form_type(score),
        "platform": detect_platform(form),
        "fills": fills,
        "unfilled": unfilled,
    }


def summarize_plan(plan, applied=None):
    """One log line. "filled" lists only fields that really hold their value on the page."""
    applied = applied or {}
    failed = applied.get("reason") if applied.get("ok") is False and applied.get("reason") else None
    bad = set(applied.get("missing") or []) | set(applied.get("unverified") or [])
    landed = [] if failed else [f["role"] for f in plan["fills"] if f["index"] not in bad]
    not_holding = [f["role"] for f in plan["fills"] if f["index"] in bad]

    parts = [f"type={plan['type']}", f"platform={plan['platform']}", f"filled={','.join(landed) or 'none'}"]
    if failed:
        parts.append(f"fill-failed={failed}")
    if not_holding:
        parts.append(f"not-holding={','.join(not_holding)}")
    if applied.get("reapplied"):
        parts.append(f"reapplied={applied['reapplied']}")
    if plan["unfilled"]:
        parts.append("unfilled=" + ",".join(u["role"] + ("(required)" if u["required"] else "") for u in plan["unfilled"]))
    return "; ".join(parts)
