#!/usr/bin/env python3
"""Turn a canon-review findings file into issue-keeper's two inputs: a STATE and a stable BODY.

No model runs here, so the decision is deterministic and testable:
  state = problem  when any CONFIRMED finding is AWAY (a leftover is an AWAY finding too), or a
                   leak gate found something or failed
  state = ok       otherwise. PLAUSIBLE findings are listed under "Unverified" but never flip
                   the state, so a guess can't open an issue on its own.

The body is STABLE for the same findings: no timestamps, no run ids, no counts of commits
reviewed. Findings are sorted (CONFIRMED before PLAUSIBLE, then severity, then
repo@sha+handle), and TOWARD/NEUTRAL verdicts stay out of it. So issue-keeper's "already says
this" check holds while nothing changed.

    render.py FINDINGS.json [--gates gates.json] [--commits commits.json] [--out BODY.md] [--max-chars N]
        prints "state=<ok|problem>", then the body. --gates replaces the gates block with
        scan.sh's own file; --commits refuses a finding on a repo@sha inputs.sh did not list.

The body is capped at --max-chars (default 60000) by dropping the LOWEST-ranked findings and
saying how many, so a long day still fits a workflow_dispatch input and stays stable.
Exit: 0 rendered; 1 the findings file is invalid (nothing is rendered, so no issue write);
      2 usage.
"""
import json
from typing import NoReturn
import sys

# The body travels as a workflow_dispatch input (the REST dispatches call), and GitHub caps a
# dispatch's inputs at 65,535 characters in all; 60,000 leaves room for the other inputs.
MAX_CHARS = 60000
VERDICTS = ("TOWARD", "NEUTRAL", "AWAY")
CONFIDENCE = ("CONFIRMED", "PLAUSIBLE")
SEVERITY = ("high", "medium", "low")
GITLEAKS = ("clean", "found", "failed")
LITERALS = ("clean", "found", "failed", "skipped")


def fail(msg) -> NoReturn:
    print(f"render.py: invalid findings: {msg}", file=sys.stderr)
    sys.exit(1)


def one_line(s):
    return " ".join(str(s).split())


def validate(d):
    if not isinstance(d, dict) or d.get("schema") != "canon-review/findings@1":
        fail('schema must be "canon-review/findings@1"')
    g = d.get("gates")
    if not isinstance(g, dict) or g.get("gitleaks") not in GITLEAKS or g.get("literals") not in LITERALS:
        fail(f"gates needs gitleaks in {GITLEAKS} and literals in {LITERALS}")
    fs = d.get("findings")
    if not isinstance(fs, list):
        fail("findings must be a list")
    for i, f in enumerate(fs):
        where = f"findings[{i}]"
        if not isinstance(f, dict):
            fail(f"{where} is not an object")
        for k in ("repo", "sha", "handle", "verdict", "confidence", "evidence"):
            if not isinstance(f.get(k), str) or not f[k].strip():
                fail(f"{where}.{k} must be a non-empty string")
        if f["verdict"] not in VERDICTS:
            fail(f"{where}.verdict must be one of {VERDICTS}")
        if f["confidence"] not in CONFIDENCE:
            fail(f"{where}.confidence must be one of {CONFIDENCE}")
        if f.get("severity", "medium") not in SEVERITY:
            fail(f"{where}.severity must be one of {SEVERITY}")
        if f["verdict"] == "AWAY" and not str(f.get("fix", "")).strip():
            fail(f"{where} is AWAY, so it needs a fix")
    return g, fs


def render(d, max_chars=MAX_CHARS):
    g, fs = validate(d)
    away = [f for f in fs if f["verdict"] == "AWAY"]
    key = lambda f: (  # noqa: E731
        CONFIDENCE.index(f["confidence"]),
        SEVERITY.index(f.get("severity", "medium")),
        f["repo"],
        f["sha"][:12],
        f["handle"],
        one_line(f["evidence"]),
    )
    away.sort(key=key)
    confirmed = [f for f in away if f["confidence"] == "CONFIRMED"]
    plausible = [f for f in away if f["confidence"] == "PLAUSIBLE"]
    gate_bad = g["gitleaks"] != "clean" or g["literals"] in ("found", "failed")
    state = "problem" if confirmed or gate_bad else "ok"

    def line(f):
        kind = "leftover · " if f.get("kind") == "leftover" else ""
        return (
            f"- **AWAY** `{f['repo']}@{f['sha'][:12]}` · **{f['handle']}** · {kind}{f.get('severity', 'medium')}"
            f" — {one_line(f['evidence'])}. **Fix:** {one_line(f['fix'])}"
        )

    lit = {"clean": "clean", "found": "**found a client literal**", "failed": "**did not run**", "skipped": "skipped (the pattern list is not reachable here)"}
    leak = {"clean": "clean", "found": "**found a secret**", "failed": "**did not run**"}
    head = (
        "Canon review: no confirmed AWAY finding and the leak gates are clean."
        if state == "ok"
        else f"Canon review: {len(confirmed)} confirmed AWAY finding(s)."
    )
    gates = f"Gates: gitleaks {leak[g['gitleaks']]}; client literals {lit[g['literals']]}."

    def body(nc, np):
        out = [head]
        if confirmed:
            out += ["", "## AWAY (confirmed)", ""] + [line(f) for f in confirmed[:nc]]
        if plausible:
            out += ["", "## Unverified (PLAUSIBLE, does not open the issue)", ""] + [line(f) for f in plausible[:np]]
        cut = (len(confirmed) - nc) + (len(plausible) - np)
        if cut:
            out += ["", f"…and {cut} more lower-ranked finding(s), not shown (the body is capped at {max_chars} characters)."]
        out += ["", gates]
        return "\n".join(out) + "\n"

    # Stable truncation: drop from the lowest rank up (PLAUSIBLE last-first, then CONFIRMED), so
    # the same findings always give the same body, and the top-ranked ones always survive.
    nc, np = len(confirmed), len(plausible)
    text = body(nc, np)
    while len(text) > max_chars and (nc or np):
        if np:
            np -= 1
        else:
            nc -= 1
        text = body(nc, np)
    return state, text


def load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as e:
        fail(f"{path}: {e}")


def usage():
    print(__doc__, file=sys.stderr)
    sys.exit(2)


def main(argv):
    if argv[:1] in (["-h"], ["--help"]):
        print(__doc__)
        sys.exit(0)
    out, max_chars, args, gates_file, commits_file = None, MAX_CHARS, [], None, None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--out", "--max-chars", "--gates", "--commits"):
            if i + 1 >= len(argv):
                usage()
            if a == "--out":
                out = argv[i + 1]
            elif a == "--gates":
                gates_file = argv[i + 1]
            elif a == "--commits":
                commits_file = argv[i + 1]
            else:
                try:
                    max_chars = int(argv[i + 1])
                except ValueError:
                    usage()
                if max_chars < 200:
                    usage()
            i += 2
            continue
        args.append(a)
        i += 1
    if len(args) != 1:
        usage()
    d = load(args[0])
    # The scripts' own outputs win over anything the model copied: the gates come from scan.sh's
    # file, and a finding must name a repo@sha that inputs.sh actually listed.
    if gates_file:
        if not isinstance(d, dict):
            fail("findings must be an object")
        d["gates"] = load(gates_file)
    if commits_file:
        listed = {(c.get("repo"), s.get("sha")) for c in load(commits_file) for s in c.get("commits", [])}
        judged = set()
        for i, f in enumerate(d.get("findings", []) if isinstance(d, dict) else []):
            if isinstance(f, dict) and (f.get("repo"), f.get("sha")) not in listed:
                fail(f"findings[{i}] names {f.get('repo')}@{str(f.get('sha'))[:12]}, which is not in the reviewed commits")
            if isinstance(f, dict) and str(f.get("evidence", "")).strip():
                judged.add((f.get("repo"), f.get("sha")))
        # Coverage is a script's call too: a skipped judgement must not look like a clean day
        # (the first live run wrote "findings": [] after reading subjects only). Every listed
        # commit needs at least one verdict with evidence, or nothing renders.
        missing = sorted(listed - judged)
        if missing:
            r, s = missing[0]
            fail(f"{len(missing)} of {len(listed)} listed commit(s) have no verdict with evidence (first: {r}@{str(s)[:12]})")
    state, body = render(d, max_chars)
    if out:
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(body)
    sys.stdout.write(f"state={state}\n{body}")


if __name__ == "__main__":
    main(sys.argv[1:])
