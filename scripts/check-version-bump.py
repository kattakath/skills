#!/usr/bin/env python3
"""Fail a PR that changes a plugin without raising that plugin's `version`.

Each plugin's `.claude-plugin/plugin.json` carries a semver `version`, and Claude Code
serves an installed copy until that string changes. So a change to `plugins/<name>/**`
that leaves the version alone ships to nobody, silently: `claude plugin update` reports
"already at the latest version" while serving stale files (measured 2026-09-30; CLAUDE.md
§ Versioning). This gate turns that silent freeze into a red check.

Rules, per plugin directory touched between BASE and HEAD:
- every plugin.json at HEAD has a `version` of the form MAJOR.MINOR.PATCH;
- a plugin that exists at BASE must have a strictly HIGHER version at HEAD;
- a new plugin needs only a valid version; a deleted plugin needs nothing.
The marketplace entry must NOT carry a version: plugin.json wins over it silently.

Usage: check-version-bump.py BASE_REF   |   check-version-bump.py --self-test
"""
import json
import re
import subprocess
import sys

SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout


def version_at(ref, name):
    try:
        raw = git("show", f"{ref}:plugins/{name}/.claude-plugin/plugin.json")
    except subprocess.CalledProcessError:
        return None, False  # plugin absent at ref
    return json.loads(raw).get("version"), True


def parse(v):
    m = SEMVER.match(v or "")
    return tuple(int(x) for x in m.groups()) if m else None


def judge(name, base_v, base_exists, head_v, head_exists):
    """Return an error string, or None when the plugin passes."""
    if not head_exists:
        return None
    if parse(head_v) is None:
        return f"plugins/{name}: version {head_v!r} is not MAJOR.MINOR.PATCH"
    if not base_exists:
        return None
    if base_v is None:  # the one-time move from versionless to versioned
        return None
    if parse(base_v) is None or parse(head_v) <= parse(base_v):
        return f"plugins/{name} changed but its version did not rise ({base_v} -> {head_v}); bump plugin.json"
    return None


def self_test():
    cases = [
        (("p", "1.0.0", True, "1.0.1", True), None),
        (("p", "1.0.0", True, "1.0.0", True), "did not rise"),
        (("p", "1.2.0", True, "1.1.9", True), "did not rise"),
        (("p", "1.0.0", True, "2.0.0", True), None),
        (("p", None, False, "1.0.0", True), None),  # new plugin
        (("p", None, False, "1.0", True), "not MAJOR.MINOR.PATCH"),
        (("p", None, True, "1.0.0", True), None),  # first versioning
        (("p", "1.0.0", True, None, True), "not MAJOR.MINOR.PATCH"),  # version removed
        (("p", "1.0.0", True, None, False), None),  # plugin deleted
        (("p", "1.9.0", True, "1.10.0", True), None),  # numeric, not string, compare
    ]
    fails = 0
    for args, want in cases:
        got = judge(*args)
        ok = (got is None) if want is None else (got is not None and want in got)
        if not ok:
            fails += 1
            print(f"FAIL {args}: want {want!r}, got {got!r}", file=sys.stderr)
    print(f"check-version-bump self-test: {len(cases) - fails}/{len(cases)} passed")
    return fails == 0


def main():
    if sys.argv[1:] == ["--self-test"]:
        sys.exit(0 if self_test() else 1)
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    base = git("merge-base", sys.argv[1], "HEAD").strip()
    changed = git("diff", "--name-only", base, "HEAD", "--", "plugins/").split()
    names = sorted({p.split("/")[1] for p in changed if p.count("/") >= 2})

    errors = []
    market = json.loads(open(".claude-plugin/marketplace.json").read())
    for e in market["plugins"]:
        if "version" in e:
            errors.append(f"marketplace entry {e['name']!r} carries a version; keep it in plugin.json only")
    for name in names:
        bv, be = version_at(base, name)
        hv, he = version_at("HEAD", name)
        err = judge(name, bv, be, hv, he)
        if err:
            errors.append(err)
    for e in errors:
        print(f"::error::{e}", file=sys.stderr)
    print(f"check-version-bump: {len(names)} changed plugin(s) checked against {base[:12]}, {len(errors)} error(s)")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
