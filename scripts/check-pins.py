#!/usr/bin/env python3
"""Fail when a plugin starts a package runner on an UNPINNED spec.

`npx -y foo` and `uvx foo` fetch whatever the registry serves at session start, so an
unpinned spec ships an upstream release to every user with no PR in this repo. Every
runner spec must carry an exact version: `name@1.2.3` (npm) or `name==1.2.3` (PyPI).

Scanned: each `plugins/*/.mcp.json` server whose command is a runner, and every runner
invocation in `plugins/**/*.sh` (the launchers that `.mcp.json` points at). A `$VAR` in
a spec is resolved from a plain `VAR=value` assignment in the same file. A spec only
known at run time passes ONLY when the line above it carries `# check-pins: pinned by
<where>`, and that code must refuse to run when the version is empty.

Dependabot cannot do this: it reads manifests (package.json, requirements.txt), and
these specs live in `.mcp.json` args and shell launchers, which it never parses.

Usage: check-pins.py [--self-test]
"""
import json
import re
import shlex
import sys
from pathlib import Path

RUNNERS = {"npx", "uvx", "bunx", "pipx"}
# Flags that take no value; anything else starting with "-" is skipped with its value
# only when listed in VALUE_FLAGS.
VALUE_FLAGS = {"--python", "-p", "--with", "--index-url", "--registry", "--cache"}
SPEC_FLAGS = {"--package", "--from"}  # the next token IS the spec
PINNED = re.compile(r"^(@[^/@\s]+/)?[^@=\s]+(@|==)\d[\w.+-]*$")


def is_pinned(spec):
    return spec == "<pinned at runtime>" or bool(PINNED.match(spec))


def spec_of(argv):
    """The package spec a runner argv (argv[0] = the runner) starts, or None."""
    i = 1
    while i < len(argv):
        a = argv[i]
        if a in SPEC_FLAGS and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith("--package=") or a.startswith("--from="):
            return a.split("=", 1)[1]
        if a in VALUE_FLAGS:
            i += 2
            continue
        if a.startswith("-"):
            i += 1
            continue
        if a in ("run", "exec") and argv[0:1] == ["pipx"]:
            i += 1
            continue
        return a
    return None


def resolve(spec, assigns):
    return re.sub(r"\$\{?(\w+)\}?", lambda m: assigns.get(m.group(1), m.group(0)), spec)


def shell_specs(text):
    """(line, spec) for each runner invocation that is a command, not a mention."""
    assigns = {}
    for m in re.finditer(r"^\s*(?:readonly\s+|local\s+)?(\w+)=(['\"]?)([^'\"\s]*)\2\s*$", text, re.M):
        assigns[m.group(1)] = m.group(3)
    out = []
    lines = text.splitlines()
    for n, line in enumerate(lines, 1):
        code = line.split(" #", 1)[0].strip()
        if code.startswith("#"):
            continue
        # A runner as the command: line start, after exec/&&/;/|/(, or after `=(`.
        m = re.search(r"(?:^|exec\s+|&&\s*|;\s*|\|\s*|\(\s*)(npx|uvx|bunx|pipx)\s+(.*)$", code)
        if not m:
            continue
        try:
            argv = shlex.split(m.group(2), comments=False)
        except ValueError:
            argv = m.group(2).split()
        argv = [a for a in argv if not a.startswith(">") and a != ")"]
        spec = spec_of([m.group(1)] + argv)
        if spec is None or spec.startswith(("$@", "\"$@")):
            continue
        spec = resolve(spec, assigns)
        prev = lines[n - 2] if n >= 2 else ""
        if "$" in spec and "check-pins: pinned by" in prev:
            spec = "<pinned at runtime>"
        out.append((n, spec))
    return out


def scan(root):
    checked, bad = 0, []
    for mcp in sorted(root.glob("plugins/*/.mcp.json")):
        servers = json.loads(mcp.read_text()).get("mcpServers", {})
        for name, s in servers.items():
            if s.get("command") not in RUNNERS:
                continue
            spec = spec_of([s["command"]] + s.get("args", []))
            checked += 1
            if spec is None or not is_pinned(spec):
                bad.append(f"{mcp.relative_to(root)}: server '{name}' runs unpinned '{spec}'")
    for sh in sorted(root.glob("plugins/**/*.sh")):
        if "/tests/" in str(sh):
            continue
        for n, spec in shell_specs(sh.read_text()):
            checked += 1
            if not is_pinned(spec):
                bad.append(f"{sh.relative_to(root)}:{n}: runs unpinned '{spec}'")
    return checked, bad


def self_test():
    cases = [
        ("exec npx -y @modelcontextprotocol/server-memory \"$@\"", False),
        ("exec npx -y @modelcontextprotocol/server-memory@2.0.1 \"$@\"", True),
        ("npx -y kapture-mcp@2.6.1 bridge", True),
        ("npx -y kapture-mcp bridge", False),
        ("npx -y --package @steipete/macos-automator-mcp@0.4.7 macos-automator-mcp", True),
        ("npx -y --package @steipete/macos-automator-mcp macos-automator-mcp", False),
        ("PIN='workspace-mcp==2.2.1'\nexec uvx \"$PIN\" --tools tasks", True),
        ("exec uvx workspace-mcp --tools tasks", False),
        ("uvx --from workspace-mcp==2.2.1 workspace-mcp", True),
        ("want_pkg=chrome-devtools-mcp\nwant_ver=1.12.0\nrunner=(npx -y \"$want_pkg@$want_ver\" --x)", True),
        ("want_pkg=chrome-devtools-mcp\nwant_ver=latest\nrunner=(npx -y \"$want_pkg@$want_ver\")", False),
        ("v=$(cat f)\nrunner=(npx -y \"pkg@$v\")", False),
        ("v=$(cat f)\n# check-pins: pinned by f (refuses when empty)\nrunner=(npx -y \"pkg@$v\")", True),
        ("command -v npx >/dev/null 2>&1 || die", None),
        ("# exec npx -y unpinned-in-a-comment", None),
        ("printf 'npx not on PATH\\n' >&2", None),
    ]
    fails = 0
    for text, want in cases:
        got = shell_specs(text)
        res = None if not got else all(is_pinned(s) for _, s in got)
        if res != want:
            fails += 1
            print(f"FAIL self-test: want {want}, got {res} {got} for {text!r}", file=sys.stderr)
    print(f"check-pins self-test: {len(cases) - fails}/{len(cases)} passed")
    return fails == 0


def main():
    if "--self-test" in sys.argv:
        sys.exit(0 if self_test() else 1)
    checked, bad = scan(Path(__file__).resolve().parent.parent)
    for b in bad:
        print(f"::error::{b}", file=sys.stderr)
    print(f"check-pins: {checked} runner spec(s) checked, {len(bad)} unpinned")
    # Floor: a moved plugins/ tree or a broken glob must not pass as zero specs.
    if checked < 8:
        print(f"::error::expected at least 8 runner specs, found {checked}", file=sys.stderr)
        sys.exit(1)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
