#!/usr/bin/env bash
# skill-usage.py against fixture transcripts and a copy of this repo, at a fixed date.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
src=$(cd "$here/../../.." && pwd)
# Ages come from git history, and CI checks out one commit. So copy this repo's entries
# into a scratch repo whose single commit is dated 2026-09-01: every entry is 91 days old.
repo=$(mktemp -d); trap 'rm -rf "$repo"' EXIT
(cd "$src" && git ls-files '.claude-plugin/*' 'index/*' '*.md' | tar -cf - -T -) | tar -xf - -C "$repo"
# jsonresume-tailor gets harvest's deprecation marker, as a `deprecate` operation would add.
sed -i '0,/^name: jsonresume-tailor$/s//name: jsonresume-tailor\ndeprecated: true\nreplaced_by: rag/' "$repo/skills/jsonresume-tailor/SKILL.md"
git -C "$repo" init -q && git -C "$repo" add -A
GIT_AUTHOR_DATE=2026-09-01T00:00:00Z GIT_COMMITTER_DATE=2026-09-01T00:00:00Z \
  git -C "$repo" -c user.name=t -c user.email=t@t commit -qm fixture
out=$(python3 "$here/../scripts/skill-usage.py" --repo "$repo" --projects "$here/fixtures/projects" --now 2026-12-01 --json)
state() { printf '%s' "$out" | python3 -c "import json,sys;print({e['name']:e['state'] for e in json.load(sys.stdin)['entries']}['$1'])"; }
fail=0
expect() { got=$(state "$1"); if [ "$got" = "$2" ]; then echo "ok   $1 = $2"; else echo "FAIL $1: want $2, got $got"; fail=1; fi; }
expect rag active                   # model Skill call 6 days ago
expect brain-signals stale          # user /brain-signals:tldr 21 days ago
expect llmstxt archive-candidate    # last use 42 days ago
expect android-phone archive-candidate  # never used across a 77-day window, old enough
expect harvest pinned
expect jsonresume-tailor deprecated  # frontmatter marker wins over usage and age
expect superhook exempt             # another entry refers to it
third=$(printf '%s' "$out" | python3 -c "import json,sys;print(','.join(json.load(sys.stdin)['third_party']))")
[ "$third" = "someone-else:thing" ] && echo "ok   third-party reported" || { echo "FAIL third-party: $third"; fail=1; }
# A 3-day window cannot prove 30 days of disuse: old, never-used skills stay active.
short=$(python3 "$here/../scripts/skill-usage.py" --repo "$repo" --projects "$here/fixtures/short-window" --now 2026-12-01 --json)
n=$(printf '%s' "$short" | python3 -c "import json,sys;print(sum(e['state'] in ('stale','archive-candidate') for e in json.load(sys.stdin)['entries']))")
[ "$n" = 0 ] && echo "ok   short window proposes nothing" || { echo "FAIL short window proposed $n"; fail=1; }
exit $fail
