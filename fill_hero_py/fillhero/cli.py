"""Command line: python fill_hero.py run|review [--settings FILE] [--live|--dry-run] [--headless]"""
import argparse
import sys

from .runner import Runner
from .settings import load_settings


def main(argv=None):
    parser = argparse.ArgumentParser(prog="fill_hero", description="Fill opted-in business contact forms.")
    parser.add_argument("command", choices=["run", "review"], help="run the domain list, or review queued forms")
    parser.add_argument("--settings", default="settings.json", help="settings file (default: settings.json)")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="fill forms but never submit")
    mode.add_argument("--live", action="store_true", help="submit forms that pass every check")
    parser.add_argument("--headless", action="store_true", help="run the browser without a window")
    args = parser.parse_args(argv)

    try:
        settings = load_settings(args.settings)
    except (OSError, ValueError) as err:
        print(f"Could not read settings: {err}", file=sys.stderr)
        return 2

    dry_run = True if args.dry_run else False if args.live else None
    headless = True if args.headless else None
    runner = Runner(settings, dry_run=dry_run, headless=headless)

    if args.command == "run":
        runner.run()
    else:
        runner.review()
    return 0
