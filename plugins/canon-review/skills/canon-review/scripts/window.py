#!/usr/bin/env python3
"""The review window's start: the last successful report run minus 2 h, else 26 h ago; never
more than 7 days back. Prints ISO-8601 UTC (Z).

    window.py [LAST_RUN_CREATED_AT] [--now ISO]    # --now is for tests
Exit: 0 printed; 2 usage or an unreadable timestamp.
"""
import datetime as d
import sys

OVERLAP = d.timedelta(hours=2)
FALLBACK = d.timedelta(hours=26)
CAP = d.timedelta(days=7)


def parse(s):
    return d.datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(d.timezone.utc)


def start(last, now):
    s = parse(last) - OVERLAP if last else now - FALLBACK
    return max(s, now - CAP)


def main(argv):
    if argv[:1] in (["-h"], ["--help"]):
        print(__doc__)
        return 0
    now = d.datetime.now(d.timezone.utc)
    if "--now" in argv:
        i = argv.index("--now")
        if i + 1 >= len(argv):
            print(__doc__, file=sys.stderr)
            return 2
        try:
            now = parse(argv[i + 1])
        except ValueError:
            return 2
        argv = argv[:i] + argv[i + 2 :]
    if len(argv) > 1:
        print(__doc__, file=sys.stderr)
        return 2
    try:
        s = start(argv[0] if argv else "", now)
    except ValueError:
        print(f"window.py: unreadable timestamp: {argv[0]}", file=sys.stderr)
        return 2
    print(s.strftime("%Y-%m-%dT%H:%M:%SZ"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
