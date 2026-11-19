"""Translate the message into the site's language with Chromium's built-in Translator.

Runs inside the page, so nothing is sent to an outside service. If the API is not
available in this Chromium, the text is returned unchanged with a reason.
"""

TRANSLATE_JS = """
async ([text, target]) => {
  try {
    if (typeof Translator === "undefined") return { ok: false, reason: "translator-api-missing" };
    const availability = await Translator.availability({ sourceLanguage: "en", targetLanguage: target });
    if (availability === "unavailable") return { ok: false, reason: "language-pair-unavailable" };
    const translator = await Translator.create({ sourceLanguage: "en", targetLanguage: target });
    return { ok: true, text: await translator.translate(text) };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
}
"""


def site_language(html_lang):
    """'fr-FR' -> 'fr'. Missing or unusable -> None."""
    import re
    m = re.match(r"^([a-z]{2,3})(?:[-_]|$)", str(html_lang or "").strip(), re.I)
    return m.group(1).lower() if m else None


def needs_translation(lang):
    return bool(lang) and lang != "en"


def translate_profile(page, profile, host, lang):
    """Returns (profile, note). The profile's message and subject are translated when needed."""
    if not needs_translation(lang):
        return profile, ""
    target = site_language(lang)
    message = (profile.get("template") or "").replace("{domain}", host).replace("{company}", profile.get("company") or "")
    msg = page.evaluate(TRANSLATE_JS, [message, target])
    if not msg.get("ok"):
        return profile, f"not-translated({msg.get('reason')})"

    subject = profile.get("subject") or ""
    if subject:
        subj = page.evaluate(TRANSLATE_JS, [subject, target])
        if subj.get("ok"):
            subject = subj["text"]
    localized = dict(profile, template=msg["text"], subject=subject)
    return localized, f"translated-to={target}"
