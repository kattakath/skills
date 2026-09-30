#!/usr/bin/env python3
"""Deterministic half of the skill curator: usage from Claude Code transcripts -> states.

Reads every transcript under the projects dir (default ~/.claude/projects), counts each
skill use (a model `Skill` tool call, or a user typing `/<name>`), and classifies the
content repo's own entries as active / stale / archive-candidate / deprecated / pinned / exempt.
No LLM, no writes: it prints a report, and the curator turns it into a PR.

    skill-usage.py --repo <content-repo> [--projects DIR] [--now YYYY-MM-DD] [--json]

Ported from the Hermes Agent curator's automatic transitions (MIT, NousResearch/hermes-agent,
docs/user-guide/features/curator): stale after 14 days unused, archive after 30, pinned and
depended-on skills skipped, never-used skills given a grace period by age.
"""
import argparse
import json
import re
import subprocess
import sys
from datetime import date, datetime, timezone
from pathlib import Path

COMMAND = re.compile(r"<command-name>/?([^<\s]+)</command-name>")


def iter_uses(projects):
    """Yield (skill_name, date) for every skill use recorded in transcripts."""
    for path in Path(projects).expanduser().rglob("*.jsonl"):
        with path.open(errors="replace") as fh:
            for line in fh:
                if '"Skill"' not in line and "<command-name>" not in line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                ts = rec.get("timestamp")
                if not ts:
                    continue
                day = datetime.fromisoformat(ts.replace("Z", "+00:00")).date()
                content = (rec.get("message") or {}).get("content")
                if rec.get("type") == "assistant" and isinstance(content, list):
                    for item in content:
                        if item.get("type") == "tool_use" and item.get("name") == "Skill":
                            name = (item.get("input") or {}).get("skill")
                            if name:
                                yield name, day
                elif rec.get("type") == "user":
                    text = content if isinstance(content, str) else json.dumps(content)
                    for name in COMMAND.findall(text):
                        yield name, day


def earliest_transcript(projects):
    """First day any transcript covers: the start of the evidence window."""
    first = None
    for path in Path(projects).expanduser().rglob("*.jsonl"):
        with path.open(errors="replace") as fh:
            for line in fh:
                m = re.search(r'"timestamp":"([^"]+)"', line)
                if m:
                    d = datetime.fromisoformat(m.group(1).replace("Z", "+00:00")).date()
                    first = d if first is None or d < first else first
                    break
    return first


def matches(entry, invoked):
    """A repo entry `x` is used by `x`, `x:<skill>` (its plugin skills) or `<ns>:x`."""
    return invoked == entry or invoked.startswith(entry + ":") or invoked.endswith(":" + entry)


def git_added(repo, rel):
    out = subprocess.run(
        ["git", "-C", str(repo), "log", "--format=%as", "--", rel],
        capture_output=True, text=True,
    ).stdout.split()
    return date.fromisoformat(out[-1]) if out else None


def deprecated(repo, p):
    """True when the entry's SKILL.md frontmatter says `deprecated: true` (harvest's marker)."""
    for f in (repo / entry_dir(p)).rglob("SKILL.md"):
        head = f.read_text(errors="replace").split("---")
        if len(head) > 2 and re.search(r"^deprecated:\s*true\s*$", head[1], re.M):
            return True
    return False


def entry_dir(p):
    return (p["skills"][0] if p.get("source") == "./" else p["source"]).removeprefix("./")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="content repo checkout (has .claude-plugin/marketplace.json)")
    ap.add_argument("--projects", default="~/.claude/projects")
    ap.add_argument("--now", help="override today (YYYY-MM-DD), for tests")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    repo = Path(args.repo)
    today = date.fromisoformat(args.now) if args.now else datetime.now(timezone.utc).date()
    cfg_path = repo / "index" / "curation.json"
    cfg = json.loads(cfg_path.read_text()) if cfg_path.exists() else {}
    stale_after = cfg.get("stale_after_days", 14)
    archive_after = cfg.get("archive_after_days", 30)
    pinned = set(cfg.get("pinned", []))

    entries = json.loads((repo / ".claude-plugin" / "marketplace.json").read_text())["plugins"]
    names = [p["name"] for p in entries]

    uses = list(iter_uses(args.projects))
    earliest = earliest_transcript(args.projects)
    evidence_days = (today - earliest).days if earliest else 0

    # Depended-on: another entry's files name this one (like Hermes skipping cron-referenced skills).
    texts = {p["name"]: "\n".join(f.read_text(errors="replace") for f in (repo / entry_dir(p)).rglob("*.md"))
             for p in entries}
    rows, third_party = [], {}
    for p in entries:
        n = p["name"]
        mine = [d for inv, d in uses if matches(n, inv)]
        last = max(mine, default=None)
        added = git_added(repo, entry_dir(p))
        age = (today - added).days if added else None
        if last:
            idle = (today - last).days
        else:
            # No use seen: absence only counts over the days the transcripts cover, and
            # over the skill's own lifetime. A one-day window proves nothing about day 20.
            idle = min(x for x in (evidence_days, age) if x is not None)
        refs = sorted(o for o, t in texts.items() if o != n and re.search(rf"`{re.escape(n)}`", t))
        if n in pinned:
            state = "pinned"
        elif deprecated(repo, p):
            state = "deprecated"  # marked by harvest; retire regardless of usage
        elif refs:
            state = "exempt"
        elif not mine and (age is None or age < stale_after):
            state = "active"  # grace: zero uses is absence of evidence, not proof
        elif idle >= archive_after:
            state = "archive-candidate"
        elif idle >= stale_after:
            state = "stale"
        else:
            state = "active"
        rows.append({"name": n, "uses": len(mine), "last_used": str(last) if last else None,
                     "added": str(added) if added else None, "idle_days": idle, "state": state,
                     "referenced_by": refs})

    for inv, d in uses:
        if not any(matches(n, inv) for n in names):
            c = third_party.setdefault(inv, {"uses": 0, "last_used": d})
            c["uses"] += 1
            c["last_used"] = max(c["last_used"], d)

    report = {
        "today": str(today),
        "window_start": str(earliest) if earliest else None,
        "evidence_days": evidence_days,
        "thresholds": {"stale_after_days": stale_after, "archive_after_days": archive_after},
        "entries": rows,
        "third_party": {k: {"uses": v["uses"], "last_used": str(v["last_used"])} for k, v in
                        sorted(third_party.items(), key=lambda kv: -kv[1]["uses"])},
    }
    if args.json:
        json.dump(report, sys.stdout, indent=2)
        print()
        return

    print(f"Skill usage as of {today}; transcripts cover {evidence_days} day(s) from {report['window_start'] or 'nothing'}")
    if evidence_days < archive_after:
        print(f"NOTE: window < {archive_after} days, so no skill can reach archive-candidate on absence alone.")
    print(f"(stale >= {stale_after}d idle, archive-candidate >= {archive_after}d idle)\n")
    print(f"{'state':18} {'uses':>4}  {'last used':10}  {'added':10}  name")
    order = {"deprecated": 0, "archive-candidate": 1, "stale": 2, "active": 3, "exempt": 4, "pinned": 5}
    for r in sorted(rows, key=lambda r: (order[r["state"]], -r["idle_days"])):
        extra = f"  (used by {', '.join(r['referenced_by'])})" if r["referenced_by"] else ""
        print(f"{r['state']:18} {r['uses']:>4}  {r['last_used'] or '-':10}  {r['added'] or '-':10}  {r['name']}{extra}")
    if third_party:
        print("\nThird-party skills used (report only):")
        for k, v in report["third_party"].items():
            print(f"  {v['uses']:>4}  {v['last_used']}  {k}")


if __name__ == "__main__":
    main()
