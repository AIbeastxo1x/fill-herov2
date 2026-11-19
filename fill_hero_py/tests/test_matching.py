import unittest

from fillhero.matching import build_fill_plan, classify_field, detect_form_type, pick_form, score_form, summarize_plan


def f(label="", type_="text", name="", tag="input", required=False, **kw):
    d = {"tag": tag, "type": type_, "name": name, "id": "", "placeholder": "", "autocomplete": "", "label": label, "required": required}
    d.update(kw)
    return d


BBE_FORM = {
    "index": 0, "hasPassword": False, "action": "https://www.bbeinc.com/contact", "id": "", "className": "",
    "fields": [
        f("First Name", name="first-name", required=True),
        f("Last Name", name="last-name", required=True),
        f("Company", name="company", required=True),
        f("Email", type_="email", name="email", required=True),
        f("Subject", name="subject"),
        f("Comment or Message", tag="textarea", type_="textarea"),
    ],
}
PROFILE = {
    "firstName": "Pat", "lastName": "Tester", "company": "Acme", "email": "pat@example.com",
    "phone": "", "subject": "Quote request", "jobTitle": "", "country": "", "address": "",
    "template": "Hello {domain} team, from {company}.",
}


class ClassifyTests(unittest.TestCase):
    def test_email_by_type(self):
        self.assertEqual(classify_field(f(type_="email")), "email")

    def test_first_and_last_name(self):
        self.assertEqual(classify_field(f(name="first-name")), "firstName")
        self.assertEqual(classify_field(f(label="Last name:")), "lastName")

    def test_full_name_is_not_last_name(self):
        self.assertEqual(classify_field(f(name="fullname")), "name")

    def test_common_labels(self):
        cases = {
            "First Name:": "firstName", "Last name:": "lastName", "Email Address:": "email",
            "Job Title:": "jobTitle", "Company Name:": "company", "Phone No.:": "phone",
            "Subject:": "subject", "Address:": "address",
        }
        for label, role in cases.items():
            self.assertEqual(classify_field(f(label=label)), role, label)

    def test_french_and_italian_labels(self):
        self.assertEqual(classify_field(f(label="Nom*")), "name")
        self.assertEqual(classify_field(f(label="Prénom")), "firstName")
        self.assertEqual(classify_field(f(label="Cognome")), "lastName")
        self.assertEqual(classify_field(f(label="Société*")), "company")

    def test_textarea_is_message_unless_address(self):
        self.assertEqual(classify_field(f(tag="textarea", type_="textarea", label="Comment or Message")), "message")
        self.assertEqual(classify_field(f(tag="textarea", type_="textarea", label="Address:")), "address")
        self.assertEqual(classify_field(f(tag="textarea", type_="textarea", label="Merci de préciser l'objet")), "message")

    def test_country_dropdown_and_other_dropdowns(self):
        self.assertEqual(classify_field(f(tag="select", label="Country:")), "country")
        self.assertEqual(classify_field(f(tag="select", label="Civilité")), "unknown")

    def test_captcha_and_honeypot_are_hidden(self):
        self.assertEqual(classify_field(f(tag="textarea", type_="textarea", name="g-recaptcha-response")), "hidden")
        self.assertEqual(classify_field(f(tag="textarea", type_="textarea", name="ak_hp_textarea")), "hidden")

    def test_unknown_text_input(self):
        self.assertEqual(classify_field(f(name="favcolor")), "unknown")


class ScoreTests(unittest.TestCase):
    def test_bbe_form_is_high(self):
        score = score_form(BBE_FORM)
        self.assertEqual(score["level"], "high")
        self.assertEqual(score["fieldMap"]["message"], 5)

    def test_newsletter_only_is_low(self):
        form = {"fields": [f(type_="email")], "hasPassword": False}
        self.assertEqual(score_form(form)["reason"], "no-message-field")

    def test_password_form_is_low(self):
        form = {"fields": [f(type_="email"), f(tag="textarea", type_="textarea")], "hasPassword": True}
        self.assertEqual(score_form(form)["reason"], "has-password")

    def test_required_dropdown_is_low(self):
        form = {"fields": [f(type_="email"), f(tag="textarea", type_="textarea"), f(tag="select", required=True)], "hasPassword": False}
        self.assertEqual(score_form(form)["reason"], "unmapped-required")

    def test_pick_prefers_high(self):
        low = {"fields": [f(type_="email")], "hasPassword": False}
        self.assertEqual(pick_form({"forms": [low, BBE_FORM]})["form"], BBE_FORM)


class PlanTests(unittest.TestCase):
    def test_fills_every_mapped_field(self):
        plan = build_fill_plan(BBE_FORM, PROFILE, "bbeinc.com")
        self.assertEqual(plan["type"], "contact")
        roles = {x["role"]: x for x in plan["fills"]}
        self.assertEqual(roles["message"]["index"], 5)
        self.assertEqual(roles["message"]["value"], "Hello bbeinc.com team, from Acme.")
        self.assertEqual(roles["subject"]["value"], "Quote request")
        self.assertEqual(plan["unfilled"], [])

    def test_empty_template_is_reported(self):
        plan = build_fill_plan(BBE_FORM, dict(PROFILE, template=""), "bbeinc.com")
        self.assertTrue(any(u["role"] == "message" and u["reason"] == "profile-empty" for u in plan["unfilled"]))
        self.assertIn("unfilled=message", summarize_plan(plan))

    def test_blank_required_company_is_flagged(self):
        plan = build_fill_plan(BBE_FORM, dict(PROFILE, company=""), "bbeinc.com")
        company = next(u for u in plan["unfilled"] if u["role"] == "company")
        self.assertTrue(company["required"])

    def test_summary_lists_only_fields_holding_their_value(self):
        plan = build_fill_plan(BBE_FORM, PROFILE, "bbeinc.com")
        applied = {"ok": False, "missing": [], "unverified": [5], "reapplied": 3}
        line = summarize_plan(plan, applied)
        self.assertIn("not-holding=message", line)
        self.assertNotIn(",message", line.split("filled=")[1].split(";")[0])

    def test_failed_fill_reports_reason(self):
        plan = build_fill_plan(BBE_FORM, PROFILE, "bbeinc.com")
        line = summarize_plan(plan, {"ok": False, "reason": "form-not-found"})
        self.assertIn("fill-failed=form-not-found", line)
        self.assertIn("filled=none", line)

    def test_detect_form_type_message_only(self):
        form = {"fields": [f(type_="email"), f(tag="textarea", type_="textarea")], "hasPassword": False}
        self.assertEqual(detect_form_type(score_form(form)), "message-only")


if __name__ == "__main__":
    unittest.main()
