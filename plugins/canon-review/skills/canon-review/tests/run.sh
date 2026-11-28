#!/usr/bin/env bash
# canon-review: the deterministic half (render.py), against fixture findings.
#   away.json   a confirmed AWAY, a confirmed leftover, a PLAUSIBLE one, a TOWARD -> problem
#   clean.json  TOWARD and NEUTRAL only, gates clean                         -> ok
# Plus stability (same input twice, and the same findings shuffled -> identical bytes),
# gate-driven problems, and invalid input refused with nothing rendered.
set -uo pipefail
H=$(cd "$(dirname "$0")/.." && pwd)
R="$H/scripts/render.py"
F="$H/tests/fixtures"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0 fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL canon-review: %s\n  got:  %s\n  want: %s\n' "$1" "$2" "$3"; fi; }
render() { python3 -I "$R" "$@"; }

check "away: matches the golden output" "$(render "$F/away.json")" "$(cat "$F/away.expected")"
check "away: state is problem" "$(render "$F/away.json" | head -1)" "state=problem"
check "clean: matches the golden output" "$(render "$F/clean.json")" "$(cat "$F/clean.expected")"
check "clean: state is ok" "$(render "$F/clean.json" | head -1)" "state=ok"

render "$F/away.json" --out "$T/body1.md" >/dev/null
render "$F/away.json" --out "$T/body2.md" >/dev/null
check "stable: the same input twice gives identical bytes" "$(cmp -s "$T/body1.md" "$T/body2.md" && echo same)" same
python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["findings"].reverse(); json.dump(d, open(sys.argv[2], "w"))' "$F/away.json" "$T/shuffled.json"
render "$T/shuffled.json" --out "$T/body3.md" >/dev/null
check "stable: the same findings in another order give identical bytes" "$(cmp -s "$T/body1.md" "$T/body3.md" && echo same)" same
check "--out holds the body exactly as stdout prints it" "$(cat "$T/body1.md")" "$(render "$F/away.json" | tail -n +2)"
check "the body carries no timestamp" "$(grep -cE '[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{2}:[0-9]{2}' "$T/body1.md")" 0

python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["findings"]=[f for f in d["findings"] if f["confidence"]=="PLAUSIBLE"]; json.dump(d, open(sys.argv[2], "w"))' "$F/away.json" "$T/plausible.json"
check "only PLAUSIBLE AWAY: state stays ok" "$(render "$T/plausible.json" | head -1)" "state=ok"
for g in '"gitleaks": "found"' '"gitleaks": "failed"' '"literals": "found"'; do
  sed "s/\"gitleaks\": \"clean\", \"literals\": \"clean\"/$g, \"x\": 0/" "$F/clean.json" |
    python3 -I -c 'import json,sys; d=json.load(sys.stdin); d["gates"].setdefault("gitleaks","clean"); d["gates"].setdefault("literals","clean"); d["gates"].pop("x",None); json.dump(d, open(sys.argv[1], "w"))' "$T/gate.json"
  check "gate $g: state is problem" "$(render "$T/gate.json" | head -1)" "state=problem"
done

printf '{"schema": "canon-review/findings@1", "gates": {"gitleaks": "clean", "literals": "clean"}, "findings": [{"repo": "r", "sha": "s", "handle": "h", "verdict": "AWAY", "confidence": "CONFIRMED", "evidence": "e"}]}' >"$T/nofix.json"
out=$(render "$T/nofix.json" 2>/dev/null); rc=$?
check "an AWAY without a fix is invalid: exit 1, nothing rendered" "$rc:$out" "1:"
printf '{"schema": "other"}' >"$T/bad.json"
out=$(render "$T/bad.json" 2>/dev/null); rc=$?
check "a wrong schema: exit 1, nothing rendered" "$rc:$out" "1:"
out=$(render "$T/none.json" 2>/dev/null); rc=$?
check "a missing file: exit 1, nothing rendered" "$rc:$out" "1:"
# The body cap: drop the lowest-ranked findings first, say how many, stay stable and in budget.
cap=$(render "$F/away.json" --max-chars 700 | tail -n +2)
check "cap: the body fits --max-chars" "$([ "${#cap}" -le 700 ] && echo fits || echo "${#cap} chars")" fits
check "cap: the top-ranked finding survives" "$(printf '%s' "$cap" | grep -c '@222222222222')" 1
check "cap: the PLAUSIBLE finding goes first" "$(printf '%s' "$cap" | grep -c '@333333333333')" 0
check "cap: it says how many are not shown" "$(printf '%s' "$cap" | grep -c 'more lower-ranked finding(s), not shown')" 1
check "cap: the gates line always survives" "$(printf '%s' "$cap" | tail -1 | grep -c '^Gates:')" 1
check "cap: stable across runs" "$(render "$F/away.json" --max-chars 700 | md5sum 2>/dev/null || render "$F/away.json" --max-chars 700 | md5)" "$(render "$F/away.json" --max-chars 700 | md5sum 2>/dev/null || render "$F/away.json" --max-chars 700 | md5)"
check "cap: the default leaves the fixture whole" "$(render "$F/away.json" | grep -c 'not shown')" 0
render "$F/away.json" --max-chars 10 >/dev/null 2>&1; check "cap below 200: usage, exit 2" "$?" 2

# The window: last successful report run minus 2 h, else 26 h back, never more than 7 days.
W="$H/scripts/window.py"
NOW=2026-11-28T12:00:00Z
check "window: last run minus 2 h" "$(python3 -I "$W" 2026-11-28T07:30:00Z --now $NOW)" 2026-11-28T05:30:00Z
check "window: no last run, 26 h back" "$(python3 -I "$W" --now $NOW)" 2026-11-27T10:00:00Z
check "window: capped at 7 days" "$(python3 -I "$W" 2026-10-01T00:00:00Z --now $NOW)" 2026-11-21T12:00:00Z
python3 -I "$W" not-a-date --now $NOW >/dev/null 2>&1; check "window: an unreadable timestamp: exit 2" "$?" 2

# --gates / --commits: the scripts' own files win over what the model copied.
printf '{"gitleaks": "failed", "literals": "skipped"}' >"$T/gates.json"
check "--gates: scan.sh's file overrides a copied 'clean' (failed scan -> problem)" "$(render "$F/clean.json" --gates "$T/gates.json" | head -1)" "state=problem"
printf '[{"repo": "kattakath/skills", "commits": [{"sha": "5555555555555555555555555555555555555555"}, {"sha": "6666666666666666666666666666666666666666"}]}]' >"$T/commits.json"
check "--commits: findings on listed commits render" "$(render "$F/clean.json" --commits "$T/commits.json" | head -1)" "state=ok"
out=$(render "$F/away.json" --commits "$T/commits.json" 2>/dev/null); rc=$?
check "--commits: a finding on an unlisted repo@sha is refused, nothing rendered" "$rc:$out" "1:"

# Coverage: every listed commit needs a verdict with evidence (the first live run rubber-stamped
# 43 commits with "findings": []).
printf '{"schema": "canon-review/findings@1", "gates": {"gitleaks": "clean", "literals": "skipped"}, "findings": []}' >"$T/empty.json"
out=$(render "$T/empty.json" --commits "$T/commits.json" 2>"$T/err"); rc=$?
check "coverage: commits listed, findings empty -> refused, nothing rendered" "$rc:$out" "1:"
check "coverage: the refusal counts what is missing" "$(grep -c '2 of 2 listed commit(s) have no verdict' "$T/err")" 1
python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["findings"]=d["findings"][:1]; json.dump(d, open(sys.argv[2], "w"))' "$F/clean.json" "$T/partial.json"
out=$(render "$T/partial.json" --commits "$T/commits.json" 2>/dev/null); rc=$?
check "coverage: one of two commits judged -> refused" "$rc:$out" "1:"
printf '[]' >"$T/nocommits.json"
check "coverage: no commits in the window, no findings -> ok" "$(render "$T/empty.json" --commits "$T/nocommits.json" | head -1)" "state=ok"

# --motto: a handle must be a row label in the rubric's table. The test builds a table of the
# SHAPE (not a copy of the rubric) with the fixtures' handles.
printf '| Handle | Rule |\n|---|---|\n| **one source** | x |\n| **look first** | x |\n| **receipts** | x |\n| **plain shape** | x |\n| **as-code** | x |\n' >"$T/motto.md"
check "--motto: fixture handles all in the table render" "$(render "$F/away.json" --motto "$T/motto.md" | head -1)" "state=problem"
python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["findings"][0]["handle"]="one-source"; json.dump(d, open(sys.argv[2], "w"))' "$F/clean.json" "$T/typo.json"
out=$(render "$T/typo.json" --motto "$T/motto.md" 2>"$T/err"); rc=$?
check "--motto: a misspelt handle is refused, nothing rendered" "$rc:$out" "1:"
check "--motto: the refusal names the bad handle" "$(grep -c "handle 'one-source' is not a handle" "$T/err")" 1
printf '# no table here\n' >"$T/notable.md"
out=$(render "$F/clean.json" --motto "$T/notable.md" 2>/dev/null); rc=$?
check "--motto: a rubric with no table is refused (the format moved)" "$rc:$out" "1:"

# scan.sh offline: a fixture repo, a hand-written commits.json, a stub gitleaks (exit $STUB_GL).
SO="$T/scan"; mkdir -p "$SO/bin" "$SO/repo"
git -C "$SO/repo" init -q
git -C "$SO/repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
printf 'hello acme-secret-client\n' >"$SO/repo/a.txt"
git -C "$SO/repo" add -A && git -C "$SO/repo" -c user.email=t@t -c user.name=t commit -q -m "add a"
git -C "$SO/repo" update-ref refs/remotes/origin/main HEAD
git -C "$SO/repo" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
sha=$(git -C "$SO/repo" rev-parse HEAD)
printf '[{"repo": "o/r", "branch": "main", "dir": "%s", "commits": [{"sha": "%s", "subject": "add a"}]}]' "$SO/repo" "$sha" >"$SO/commits.json"
printf '#!/usr/bin/env bash\nexit "${STUB_GL:-0}"\n' >"$SO/bin/gitleaks"; chmod +x "$SO/bin/gitleaks"
printf 'acme-secret-client\n' >"$SO/lits"
printf '(\n' >"$SO/badre"
scan() { PATH="$SO/bin:$PATH" CI_LAND_LITERALS="$1" STUB_GL="$2" bash "$H/scripts/scan.sh" "$SO" 2>"$SO/err"; jq -r '"\(.gitleaks) \(.literals)"' "$SO/gates.json"; }
check "scan: clean repo, no list: clean skipped" "$(scan /none 0)" "clean skipped"
check "scan: gitleaks exit 42 (a leak) is found" "$(scan /none 42)" "found skipped"
check "scan: gitleaks exit 1 (an error) is failed, not found" "$(scan /none 1)" "failed skipped"
check "scan: a planted literal is found" "$(scan "$SO/lits" 0)" "clean found"
check "scan: a broken pattern is failed, not 'not reachable'" "$(scan "$SO/badre" 0)" "clean failed"
seq 1 30 | sed 's/^/line /' >"$SO/repo/b.txt"
git -C "$SO/repo" add -A && git -C "$SO/repo" -c user.email=t@t -c user.name=t commit -q -m "add b"
sha2=$(git -C "$SO/repo" rev-parse HEAD)
printf '[{"repo": "o/r", "branch": "main", "dir": "%s", "commits": [{"sha": "%s", "subject": "add b"}, {"sha": "%s", "subject": "add a"}]}]' "$SO/repo" "$sha2" "$sha" >"$SO/commits.json"
bash "$H/scripts/dump.sh" "$SO" --cap 10 2>/dev/null; rc=$?
check "dump: one file per repo, a section per commit" "$rc:$(grep -c '^=== o/r@' "$SO/rev/o_r.txt")" "0:2"
check "dump: --stat is there" "$(grep -c 'b.txt | 30 +' "$SO/rev/o_r.txt")" 1
check "dump: a long diff is capped and says so" "$(grep -c '^\[truncated: 10 of [0-9]* lines\]$' "$SO/rev/o_r.txt")" 1
check "dump: the capped section holds at most the cap" "$(awk '/^=== o\/r@'"$sha2"'/{on=1;next} /^=== /{on=0} on&&/^--- diff/{d=1;next} on&&d&&/^\[truncated/{exit} on&&d{n++} END{print n}' "$SO/rev/o_r.txt")" 10
bash "$H/scripts/dump.sh" "$SO" --cap 0 2>/dev/null; check "dump: --cap 0 is a usage error" "$?" 2
# The shared resolver's pinned download, offline: a stub curl serves the "release".
GR="$H/scripts/gitleaks-resolve.sh"
mkdir -p "$SO/curlbin" "$SO/glbin"
printf '#!/usr/bin/env bash\nwhile [ $# -gt 1 ]; do [ "$1" = -o ] && out=$2; shift; done\nprintf "not the real tarball" >"$out"\n' >"$SO/curlbin/curl"; chmod +x "$SO/curlbin/curl"
out=$(PATH="$SO/curlbin:$PATH" bash -c '. "$1"; gl_fetch "$2"' _ "$GR" "$SO/glbin" 2>"$SO/gr.err"); rc=$?
check "resolver: a tampered download fails its sha256 check, nothing installed" "$rc:$out:$(ls "$SO/glbin")" "1::"
check "resolver: it says why" "$(grep -c 'failed its sha256 check' "$SO/gr.err")" 1
printf '#!/bin/sh\n' >"$SO/glbin/gitleaks"; chmod +x "$SO/glbin/gitleaks"
check "resolver: a verified binary already in BINDIR is reused, no download" "$(PATH="$SO/curlbin:$PATH" bash -c '. "$1"; gl_fetch "$2"' _ "$GR" "$SO/glbin")" "$SO/glbin/gitleaks"
check "resolver: the copy matches ci-watch's source (one GL_VERSION)" "$(grep -c '^GL_VERSION=' "$GR"):$(tail -n +2 "$GR" | cmp -s - "$H/../../../ci-watch/scripts/gitleaks-resolve.sh" && echo same)" "1:same"
check "scan: no pattern text reaches its output" "$(scan "$SO/lits" 0 >/dev/null; grep -ci 'acme-secret' "$SO/err" "$SO/gates.json" | awk -F: '{s+=$2} END {print s}')" 0

# report.sh (step 4) against a stub gh that records its argv, one word per line.
RO="$T/report"; mkdir -p "$RO/bin"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@" >"%s/gh.argv"\nexit "${STUB_GH:-0}"\n' "$RO" >"$RO/bin/gh"; chmod +x "$RO/bin/gh"
cp "$F/clean.json" "$RO/findings.json"
printf '{"gitleaks": "clean", "literals": "skipped"}' >"$RO/gates.json"
cp "$T/commits.json" "$RO/commits.json"; cp "$T/motto.md" "$RO/motto.md"
rep() { rm -f "$RO/gh.argv"; PATH="$RO/bin:$PATH" bash "$H/scripts/report.sh" "$@" >/dev/null 2>&1; }
rep "$RO"; rc=$?
check "report: dispatches, exit 0" "$rc" 0
check "report: REST dispatches endpoint, never gh workflow run" "$(head -4 "$RO/gh.argv" | tr '\n' ' ')" "api -X POST repos/kattakath/.github/actions/workflows/canon-review-report.yml/dispatches "
check "report: sends source=cloud (the scheduler heartbeat)" "$(grep -cx 'inputs\[source\]=cloud' "$RO/gh.argv")" 1
check "report: sends render's state" "$(grep -cx 'inputs\[state\]=ok' "$RO/gh.argv")" 1
check "report: sends the body file unchanged" "$(grep -c '^inputs\[body\]=Canon review: no confirmed AWAY' "$RO/gh.argv")" 1
check "report: on ref main" "$(grep -cx 'ref=main' "$RO/gh.argv")" 1
cp "$F/away.json" "$RO/findings.json"
rep "$RO"; check "report: invalid findings (unlisted sha): exit 1, nothing dispatched" "$?:$(test -f "$RO/gh.argv" && echo sent || echo none)" "1:none"
cp "$F/clean.json" "$RO/findings.json"
rep "$RO" --dry-run; check "report: --dry-run dispatches nothing" "$?:$(test -f "$RO/gh.argv" && echo sent || echo none)" "0:none"
STUB_GH=1 rep "$RO"; check "report: a failed dispatch exits 1" "$?" 1
cp "$T/empty.json" "$RO/findings.json"
rep "$RO"; check "report: a rubber stamp (no verdicts) dispatches nothing" "$?:$(test -f "$RO/gh.argv" && echo sent || echo none)" "1:none"
cp "$F/clean.json" "$RO/findings.json"

render 2>/dev/null; check "no arguments: usage, exit 2" "$?" 2
out=$(render --help); rc=$?
check "--help: stdout, exit 0" "$rc:$(printf '%s' "$out" | grep -c 'render.py FINDINGS.json')" "0:1"

echo "canon-review: $pass passed, $fail failed"
[ "$fail" = 0 ]
