"""Live fill-and-submit test against a local fixture site.

Starts a small web server on 127.0.0.1 that serves fixture/ (a copy of the test site), then
runs the real browser flow against it: the form is filled, submitted, and the fixture
records what it received. Nothing leaves this computer.

Run from the fill_hero_py folder:
    python -m unittest tests.test_live_fixture -v
"""
import csv
import json
import os
import tempfile
import threading
import unittest
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import parse_qs, urlsplit

from fillhero.runner import Runner
from fillhero.settings import load_settings

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.normpath(os.path.join(HERE, "..", "fixture"))


class RecordingHandler(SimpleHTTPRequestHandler):
    requests = []  # every path requested, including form submissions

    def log_message(self, *args):
        pass  # keep the test output quiet

    def do_GET(self):
        RecordingHandler.requests.append(self.path)
        super().do_GET()


class LiveFixtureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        handler = partial(RecordingHandler, directory=FIXTURE)
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        RecordingHandler.requests.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def make_runner(self, dry_run):
        settings_path = os.path.join(self.root, "settings.json")
        with open(settings_path, "w", encoding="utf-8") as fh:
            json.dump({
                "profile": {
                    "firstName": "Pat", "lastName": "Tester", "company": "Acme",
                    "email": "pat@example.com", "subject": "Quote request",
                    "template": "Hello {domain} team, from {company}.",
                },
                "run": {"dry_run": dry_run, "headless": True, "gap_seconds": 0,
                        "random_delay_seconds": [0, 0]},
                "files": {
                    "domains": os.path.join(self.root, "domains.txt"),
                    "message": os.path.join(self.root, "message.txt"),
                    "log": os.path.join(self.root, "output", "log.csv"),
                    "state": os.path.join(self.root, "output", "state.json"),
                    "queue": os.path.join(self.root, "output", "queue.json"),
                    "browser_profile": os.path.join(self.root, "output", "browser-profile"),
                },
            }, fh)
        with open(os.path.join(self.root, "domains.txt"), "w", encoding="utf-8") as fh:
            fh.write(f"http://127.0.0.1:{self.port}/\n")
        settings = load_settings(settings_path)
        return Runner(settings, dry_run=dry_run, headless=True), os.path.join(self.root, "output", "log.csv")

    def read_log(self, path):
        with open(path, newline="", encoding="utf-8") as fh:
            return list(csv.DictReader(fh))

    def test_live_fill_and_submit_sends_the_form(self):
        runner, log_path = self.make_runner(dry_run=False)
        runner.run()

        rows = self.read_log(log_path)
        self.assertEqual(len(rows), 1, rows)
        self.assertEqual(rows[0]["status"], "sent", rows[0])
        self.assertIn("filled=firstName,lastName,company,email,subject,message", rows[0]["reason"])

        # The fixture received the form submission, with the values we filled in.
        submitted = [p for p in RecordingHandler.requests if p.startswith("/thanks.html?")]
        self.assertEqual(len(submitted), 1, RecordingHandler.requests)
        received = {k: v[0] for k, v in parse_qs(urlsplit(submitted[0]).query).items()}
        self.assertEqual(received["first-name"], "Pat")
        self.assertEqual(received["last-name"], "Tester")
        self.assertEqual(received["company"], "Acme")
        self.assertEqual(received["email"], "pat@example.com")
        self.assertEqual(received["subject"], "Quote request")
        self.assertTrue(received["message"].startswith(f"Hello 127.0.0.1:{self.port} team"))
        self.assertIn("from Acme.", received["message"])

    def test_dry_run_fills_but_does_not_submit(self):
        runner, log_path = self.make_runner(dry_run=True)
        runner.run()

        rows = self.read_log(log_path)
        self.assertEqual(rows[0]["status"], "skipped", rows[0])
        self.assertIn("dry-run", rows[0]["reason"])
        self.assertFalse(any(p.startswith("/thanks.html") for p in RecordingHandler.requests))


if __name__ == "__main__":
    unittest.main()
