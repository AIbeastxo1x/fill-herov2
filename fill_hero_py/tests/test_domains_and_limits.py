import os
import tempfile
import unittest

from fillhero.contact import find_contact_links
from fillhero.limits import can_submit, record_submit
from fillhero.normalize import normalize_domain, parse_domain_list
from fillhero.settings import load_settings
from fillhero.store import already_sent, append_log, read_log
from fillhero.translate import needs_translation, site_language


class NormalizeTests(unittest.TestCase):
    def test_bare_domain_becomes_https(self):
        self.assertEqual(normalize_domain("example.com"), {"ok": True, "url": "https://example.com/", "host": "example.com"})

    def test_path_and_case_are_cleaned(self):
        self.assertEqual(normalize_domain("  HTTPS://Example.COM/about/ ")["host"], "example.com")

    def test_rejects_empty_and_single_label(self):
        self.assertFalse(normalize_domain("")["ok"])
        self.assertFalse(normalize_domain("http://")["ok"])
        self.assertFalse(normalize_domain("intranet")["ok"])

    def test_localhost_keeps_scheme_and_port(self):
        r = normalize_domain("http://localhost:8000/contact.html")
        self.assertEqual(r, {"ok": True, "url": "http://localhost:8000/", "host": "localhost:8000"})

    def test_parse_list_splits_lines_and_commas(self):
        out = parse_domain_list("a.com\n\nb.com, c.com")
        self.assertEqual(len(out), 3)
        self.assertTrue(all(x["ok"] for x in out))


class ContactLinkTests(unittest.TestCase):
    def test_same_site_contact_links_deduplicated(self):
        out = find_contact_links(
            [{"href": "/contact", "text": "Contact Us"}, {"href": "https://example.com/contact", "text": "Contact"}, {"href": "/about", "text": "About"}],
            "https://example.com/",
        )
        self.assertEqual(out, ["https://example.com/contact"])

    def test_other_hosts_ignored_and_fallback_used(self):
        out = find_contact_links([{"href": "https://other.com/contact", "text": "Contact"}], "https://example.com/")
        self.assertEqual(out, ["https://example.com/contact", "https://example.com/contact-us"])

    def test_www_and_bare_host_are_the_same_site(self):
        out = find_contact_links([{"href": "/contact/", "text": "CONTACTEZ-NOUS"}], "https://www.enag.fr/")
        self.assertEqual(out, ["https://www.enag.fr/contact/"])


class LimitTests(unittest.TestCase):
    NOW = 1789603200.0  # a fixed moment

    def test_allowed_after_gap(self):
        self.assertTrue(can_submit({"last_submit_at": 0, "daily_count": 0, "daily_date": ""}, self.NOW, 60, 50)["ok"])

    def test_waits_for_gap(self):
        r = can_submit({"last_submit_at": self.NOW - 30, "daily_count": 1, "daily_date": ""}, self.NOW, 60, 50)
        self.assertEqual((r["ok"], r["reason"]), (False, "gap"))
        self.assertAlmostEqual(r["wait"], 30)

    def test_daily_cap(self):
        from fillhero.limits import local_date
        state = {"last_submit_at": 0, "daily_count": 50, "daily_date": local_date(self.NOW)}
        self.assertEqual(can_submit(state, self.NOW, 60, 50)["reason"], "daily-cap")

    def test_record_resets_on_new_day(self):
        s = record_submit({"last_submit_at": 0, "daily_count": 50, "daily_date": "1999-01-01"}, self.NOW)
        self.assertEqual(s["daily_count"], 1)


class StoreAndSettingsTests(unittest.TestCase):
    def test_log_round_trip_and_sent_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "out", "log.csv")
            append_log(path, "a.com", "queued", 'has "quotes", commas', "https://a.com/contact")
            append_log(path, "b.com", "sent", "ok")
            self.assertEqual(len(read_log(path)), 2)
            self.assertTrue(already_sent(path, "b.com"))
            self.assertFalse(already_sent(path, "a.com"))

    def test_domains_file_is_read_one_per_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "domains.txt"), "w", encoding="utf-8") as fh:
                fh.write("# comment\nenag.fr\n\n  persiehl.de  \nhttps://www.bbeinc.com/contact\n")
            with open(os.path.join(tmp, "settings.json"), "w", encoding="utf-8") as fh:
                fh.write('{"domains": ["ignored.com"]}')
            s = load_settings(os.path.join(tmp, "settings.json"))
            self.assertEqual(s["domains"], ["enag.fr", "persiehl.de", "https://www.bbeinc.com/contact"])

    def test_message_file_overrides_profile_template(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "message.txt"), "w", encoding="utf-8") as fh:
                fh.write("Hi {domain},\n\nLine two.\n{company}\n")
            with open(os.path.join(tmp, "settings.json"), "w", encoding="utf-8") as fh:
                fh.write('{"profile": {"template": "ignored"}}')
            s = load_settings(os.path.join(tmp, "settings.json"))
            self.assertEqual(s["profile"]["template"], "Hi {domain},\n\nLine two.\n{company}")

    def test_settings_defaults_and_relative_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "settings.json")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write('{"domains": ["a.com"], "profile": {"firstName": "Pat"}}')
            s = load_settings(path)
            self.assertEqual(s["profile"]["firstName"], "Pat")
            self.assertEqual(s["profile"]["template"], "Hello {domain} team,\n\n")
            self.assertTrue(s["run"]["dry_run"])
            self.assertTrue(s["files"]["log"].startswith(tmp))


class TranslateTests(unittest.TestCase):
    def test_language_and_need(self):
        self.assertEqual(site_language("fr-FR"), "fr")
        self.assertEqual(site_language(""), None)
        self.assertTrue(needs_translation("fr"))
        self.assertFalse(needs_translation("en"))


if __name__ == "__main__":
    unittest.main()
