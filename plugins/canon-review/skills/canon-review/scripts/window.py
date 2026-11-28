#!/usr/bin/env python3
"""The review window's start: the last successful report run minus 2 h. NO cap: the review is on
demand, runs can be weeks apart, and a cap would silently skip commits. With no prior report
there is no start to infer, so the caller must pass --since (inputs.sh turns this exit into
"pass --since").

The 2 h overlap re-reviews a few commits rather than miss any: the report run is created at the
END of a review, so commits pushed while a review ran would otherwise fall between windows.

    window.py [LAST_RUN_CREATED_AT] [--now ISO]    # --now is for tests
Exit: 0 printed (ISO-8601 UTC, Z); 3 no prior report, so no start (pass --since);
      2 usage or an unreadable timestamp.
"""
import datetime as d
import sys

OVERLAP = d.timedelta(hours=2)
NO_START = 3


def parse(s):
    return d.datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(d.timezone.utc)


def main(argv):
    if argv[:1] in (["-h"], ["--help"]):
        print(__doc__)
        return 0
    if "--now" in argv:  # accepted for tests and older callers; the start doesn't depend on it
        i = argv.index("--now")
        if i + 1 >= len(argv):
            print(__doc__, file=sys.stderr)
            return 2
        argv = argv[:i] + argv[i + 2 :]
    if len(argv) > 1:
        print(__doc__, file=sys.stderr)
        return 2
    if not argv or not argv[0]:
        print("window.py: no prior successful report run, so no window start; pass --since", file=sys.stderr)
        return NO_START
    try:
        s = parse(argv[0]) - OVERLAP
    except ValueError:
        print(f"window.py: unreadable timestamp: {argv[0]}", file=sys.stderr)
        return 2
    print(s.strftime("%Y-%m-%dT%H:%M:%SZ"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
