#!/usr/bin/env bash
# Case suite for scripts/ci-watch.js. No network: `gh`, `glab` and `git` are tests/fixtures/gh-stub.js.
#
# The halves that matter:
#   silent-GREEN  all runs pass -> exit 0, NOTHING on stdout or stderr, no report written
#   never-GREEN   zero runs, all-skipped runs, a run that registers late (even after a long
#                 one completes), a still-running or a cancelled run is not green
#   resolved-RED  the report names run/job/step ids, numbered log lines and rerun commands
#   hook-QUIET    non-pushes, dry runs, feature-branch and rejected pushes, and a re-watched
#                 sha exit 0 without asking GitHub anything about runs
#   hook-LOUD     once a push to the default branch landed, every failure wakes (exit 2)
#   gitlab        the same contract for a gitlab.com remote, through glab
#   wiring        hooks.json: asyncRewake, a timeout above the script's worst case
# Run:  bash plugins/ci-watch/tests/run.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CW="$HERE/../scripts/ci-watch.js"
HOOKS="$HERE/../hooks/hooks.json"
STUB="$HERE/fixtures/gh-stub.js"
S=0123456789abcdef0123456789abcdef01234567
pass=0; fail=0
ROOT="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$ROOT"' EXIT

check() { # label got want
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s\n  got:  %s\n  want: %s\n' "$1" "$2" "$3"; fi
}

# fx <name>  -> fresh fixture dir F with repo.json + commit.json for sha $S
fx() {
  F="$ROOT/$1"; mkdir -p "$F/out" "$F/sub"
  printf '{"nameWithOwner":"o/r","defaultBranchRef":{"name":"main"}}' >"$F/repo.json"
  printf '{"sha":"%s","commit":{"message":"fix: thing\\n\\nbody"},"files":[{"filename":"a.nix"},{"filename":"b.md"}]}' "$S" >"$F/commit.json"
}
# runs <k> <id:workflow:status:conclusion>...  -> run-list.<k>.json (createdAt = now, or $OLD)
runs() {
  local k=$1; shift
  python3 -I - "$F/run-list.$k.json" "${OLD:-}" "$@" <<'PY'
import datetime, json, sys
at = sys.argv[2] or datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
out = []
for spec in sys.argv[3:]:
    i, wf, st, co = spec.split(":")
    out.append({"databaseId": int(i), "workflowName": wf, "event": "push", "status": st,
                "conclusion": co, "url": f"https://github.com/o/r/actions/runs/{i}", "createdAt": at})
json.dump(out, open(sys.argv[1], "w"))
PY
}

ENVV=()
setenv() {
  ENVV=(CI_WATCH_FIXTURE="$F" CI_WATCH_GH="$STUB" CI_WATCH_GLAB="$STUB" CI_WATCH_GIT="$STUB" CI_WATCH_DIR="$F/out"
    CI_WATCH_APPEAR_S="${APPEAR:-0.3}" CI_WATCH_SETTLE_S="${SETTLE:-0}" CI_WATCH_POLL_S=0.02 CI_WATCH_CEILING_S="${CEIL:-2}")
}
# cw [args...] -> runs the CLI against fixture F; sets OUT ERR RC
cw() {
  local o e; o=$(mktemp); e=$(mktemp); setenv
  env "${ENVV[@]}" node "$CW" "$@" >"$o" 2>"$e"; RC=$?
  OUT=$(cat "$o"); ERR=$(cat "$e"); rm -f "$o" "$e"
}
# hk <command> [head] [stderr-of-the-push]  -> runs --hook with a PostToolUse payload
hk() {
  local o e payload; o=$(mktemp); e=$(mktemp); setenv
  payload=$(python3 -I -c 'import json,sys; print(json.dumps({"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":sys.argv[1]},"tool_response":{"stdout":"","stderr":sys.argv[3]},"cwd":sys.argv[2]}))' "$1" "$F" "${3:-}")
  printf '%s' "$payload" | env "${ENVV[@]}" CI_WATCH_FAKE_HEAD="${2:-}" node "$CW" --hook >"$o" 2>"$e"; RC=$?
  OUT=$(cat "$o"); ERR=$(cat "$e"); rm -f "$o" "$e"
}
report() { cat "$F/out/o--r-$S.json" 2>/dev/null; }
# j <python expr over d=report>
j() { report | python3 -I -c "import json,sys
try: d=json.load(sys.stdin)
except Exception: print('__NOREPORT__'); sys.exit()
print($1)"; }
calls() { grep -c "^$1" "$F/calls.log" 2>/dev/null || true; }
none() { test -f "$F/calls.log" && grep -q '^run list' "$F/calls.log" && echo listed || echo none; }

# ---- silent-GREEN -------------------------------------------------------------------
fx green; runs 1 "11:nix-ci:completed:success" "12:publish:completed:skipped" "13:lint:completed:neutral"; cw
check "green: exit 0" "$RC" 0
check "green: stdout empty" "$OUT" ""
check "green: stderr empty" "$ERR" ""
check "green: no report written" "$(find "$F/out" -type f | wc -l | tr -d ' ')" 0

# ---- never-GREEN --------------------------------------------------------------------
fx none; runs 1; cw
check "no runs: exit 3" "$RC" 3
check "no runs: status" "$(j 'd["status"]')" NO_RUNS
check "no runs: summary says nothing checked" "$(grep -c 'nothing checked this commit' <<<"$ERR")" 1

fx skipped; runs 1 "14:nix-ci:completed:skipped" "15:publish:completed:neutral"; cw
check "all skipped: not green (exit 3)" "$RC" 3
check "all skipped: note says so" "$(j '"skipped or neutral" in d["note"]')" True

fx late; runs 1; runs 3 "21:nix-ci:completed:success"; cw
check "late run: exit 0 once it appears" "$RC" 0
check "late run: polled until it appeared" "$([ "$(calls 'run list')" -ge 3 ] && echo yes)" yes

fx settle; runs 1 "31:nix-ci:completed:success"; runs 2 "31:nix-ci:completed:success" "32:publish:in_progress:"
runs 4 "31:nix-ci:completed:success" "32:publish:completed:failure"; SETTLE=0.1 cw
check "settle: a run that registers late is waited for" "$RC" 1
check "settle: the late run is the red one" "$(j 'd["failures"][0]["run_id"]')" 32

# A long run completes after SETTLE_S has passed; a workflow_run it triggers registers
# only then. Completion must restart the quiet period, or the chained red is missed.
fx chain; runs 1 "33:nix-ci:in_progress:"; runs 10 "33:nix-ci:completed:success"
runs 11 "33:nix-ci:completed:success" "34:deploy:queued:"; runs 14 "33:nix-ci:completed:success" "34:deploy:completed:failure"
printf '{"jobs":[]}' >"$F/run-view-34.json"; SETTLE=0.1 cw
check "chain: a run triggered by a long run's completion is seen" "$RC" 1
check "chain: it is the chained run that is red" "$(j 'd["failures"][0]["run_id"]')" 34

fx running; runs 1 "41:nix-ci:in_progress:"; CEIL=0.2 cw
check "ceiling: exit 4" "$RC" 4
check "ceiling: status" "$(j 'd["status"]')" STILL_RUNNING
check "ceiling: pending names the run" "$(j '",".join(d["pending"])')" nix-ci
check "ceiling: clamped to 2700s at most" "$(grep -c 'Math.min(num("CI_WATCH_CEILING_S", 2700), 2700)' "$CW")" 1

fx cancelled; runs 1 "51:nix-ci:completed:cancelled"
printf '{"jobs":[]}' >"$F/run-view-51.json"; cw
check "cancelled is red" "$RC" 1
check "cancelled: conclusion kept" "$(j 'd["failures"][0]["conclusion"]')" cancelled
check "cancelled with no jobs: job is null" "$(j 'd["failures"][0]["job_id"]')" None

# ---- resolved-RED -------------------------------------------------------------------
fx red; runs 1 "61:nix-ci:completed:failure" "62:publish:completed:success"
cat >"$F/run-view-61.json" <<'JSON'
{"jobs":[
 {"databaseId":601,"name":"build (aarch64-linux)","conclusion":"failure","url":"https://github.com/o/r/actions/runs/61/job/601",
  "steps":[{"number":1,"name":"Set up job","conclusion":"success","startedAt":"2026-11-07T11:00:00Z","completedAt":"2026-11-07T11:00:01Z"},
           {"number":4,"name":"Build","conclusion":"failure","startedAt":"2026-11-07T11:00:02Z","completedAt":"2026-11-07T11:00:05Z"},
           {"number":5,"name":"Post","conclusion":"skipped"}]},
 {"databaseId":602,"name":"gitleaks","conclusion":"success","url":"u","steps":[]}]}
JSON
{
  printf '2026-11-07T11:00:00.1000000Z Current runner version\n'
  printf '2026-11-07T11:00:01.5000000Z setup noise\n'
  printf '2026-11-07T11:00:02.1000000Z ##[group]Run nix build\n'
  printf '2026-11-07T11:00:03.0000000Z \033[31merror:\033[0m attribute missing\n'
  printf '2026-11-07T11:00:04.0000000Z ##[error]Process completed with exit code 1.\n'
  printf '2026-11-07T11:00:09.0000000Z Post job cleanup\n'
} >"$F/job-601.log"
cw
check "red: exit 1" "$RC" 1
check "red: status" "$(j 'd["status"]')" RED
check "red: schema" "$(j 'd["schema"]')" ci-watch/report@1
check "red: full sha" "$(j 'd["sha"]')" "$S"
check "red: subject is the first line" "$(j 'd["subject"]')" "fix: thing"
check "red: changed files" "$(j '",".join(d["changed_files"])')" "a.nix,b.md"
check "red: only the failed job is reported" "$(j 'len(d["failures"])')" 1
check "red: job id" "$(j 'd["failures"][0]["job_id"]')" 601
check "red: failing step number" "$(j 'd["failures"][0]["step"]["number"]')" 4
check "red: failing step name" "$(j 'd["failures"][0]["step"]["name"]')" Build
check "red: no internal fields leak into the report" "$(j 'sorted(d["failures"][0])==sorted(["run_id","workflow","run_url","conclusion","job_id","job","job_url","step","log","commands"])')" True
check "red: error line number is the real one" "$(j 'd["failures"][0]["log"]["error_lines"]')" "[5]"
check "red: excerpt starts inside the step window" "$(j 'd["failures"][0]["log"]["lines"][0]["n"]')" 3
check "red: post-step lines are cut" "$(j 'max(l["n"] for l in d["failures"][0]["log"]["lines"])')" 5
check "red: ANSI stripped" "$(j 'd["failures"][0]["log"]["lines"][1]["text"]')" "error: attribute missing"
check "red: rerun command names the run" "$(j 'd["failures"][0]["commands"]["rerun"]')" "gh run rerun 61 --repo o/r --failed"
check "red: summary names job and step" "$(grep -c 'build (aarch64-linux) > step 4 "Build"' <<<"$ERR")" 1
check "red: summary quotes the error line" "$(grep -c 'L5: ##\[error\]Process completed' <<<"$ERR")" 1
check "red: summary points at the report" "$(grep -c "o--r-$S.json" <<<"$ERR")" 1

fx nolog; runs 1 "71:nix-ci:completed:failure"
printf '{"jobs":[{"databaseId":701,"name":"j","conclusion":"failure","url":"u","steps":[]}]}' >"$F/run-view-71.json"; cw
check "missing log: still red" "$RC" 1
check "missing log: error recorded" "$(j '"error" in d["failures"][0]["log"]')" True

fx many; runs 1 "72:nix-ci:completed:failure"
python3 -I -c 'import json; print(json.dumps({"jobs":[{"databaseId":800+i,"name":f"j{i}","conclusion":"failure","url":"u","steps":[]} for i in range(7)]}))' >"$F/run-view-72.json"
for i in 0 1 2 3 4 5 6; do printf '##[error]boom %s\n' "$i" >"$F/job-80$i.log"; done; cw
check "many failed jobs: all 7 reported" "$(j 'len(d["failures"])')" 7
check "many failed jobs: logs fetched for the first 5 only" "$(grep -c 'jobs/80[0-9]/logs' "$F/calls.log")" 5
check "many failed jobs: the 6th says why it has no log" "$(j '"first 5" in d["failures"][5]["log"]["error"]')" True

# ---- excerpt cap keeps the FIRST error -----------------------------------------------
cap=$(node -e '
const {excerpt}=require(process.argv[1]);
const L=[]; for(let i=1;i<=120;i++) L.push(i===41?"##[error]root cause":i===101?"##[error]Process completed with exit code 1.":"line "+i);
const r=excerpt(L.join("\n"),null); process.stdout.write(JSON.stringify({e:r.error_lines,has41:r.lines.some(l=>l.n===41),has101:r.lines.some(l=>l.n===101),n:r.lines.length}));' "$CW")
check "excerpt cap: both errors found" "$(python3 -I -c 'import json,sys; print(json.loads(sys.argv[1])["e"])' "$cap")" "[41, 101]"
check "excerpt cap: first error kept" "$(python3 -I -c 'import json,sys; print(json.loads(sys.argv[1])["has41"])' "$cap")" True
check "excerpt cap: last error kept" "$(python3 -I -c 'import json,sys; print(json.loads(sys.argv[1])["has101"])' "$cap")" True
check "excerpt cap: at most 60 lines" "$(python3 -I -c 'import json,sys; print(json.loads(sys.argv[1])["n"]<=60)' "$cap")" True

# ---- CLI input ----------------------------------------------------------------------
fx short; runs 1 "81:nix-ci:completed:success"; cw --sha 0123456
check "short sha expands to the full one and watches it" "$RC" 0
check "short sha: run list used the FULL sha" "$(grep -c -- "--commit $S" "$F/calls.log")" 1
fx badref; printf '{"sha":"nope"}' >"$F/commit-zzz.json"; cw --sha zzz
check "unresolvable ref: exit 64" "$RC" 64
check "unknown flag: exit 64" "$(cw --bogus; echo "$RC")" 64

# ---- hook-QUIET --------------------------------------------------------------------
fx hq1; hk "ls -la"
check "hook: non-git command exits 0" "$RC" 0
check "hook: non-git command asks nothing" "$(test -f "$F/calls.log" && echo called || echo none)" none
fx hq2; hk "git push --dry-run origin HEAD:main" "$S"
check "hook: dry run ignored" "$(test -f "$F/calls.log" && echo called || echo none)" none
fx hq3; hk "echo git push is a phrase"
check "hook: 'git push' inside an echo is not a push" "$(test -f "$F/calls.log" && echo called || echo none)" none
fx hq4; runs 1 "91:nix-ci:completed:failure"; hk "git push origin feature" "$S"
check "hook: push to another branch exits 0" "$RC" 0
check "hook: push to another branch lists no runs" "$(none)" none
fx hq5; runs 1 "91:nix-ci:completed:failure"; CI_WATCH_FAKE_BRANCH=feat hk "git push" "$S"
check "hook: bare push on a feature branch lists no runs" "$(none)" none
fx hq6; runs 1 "91:nix-ci:completed:failure"; hk 'git commit -m "bump main config" && git push origin feat' "$S"
check "hook: 'main' in a commit message does not target main" "$(none)" none
fx hq7; runs 1 "91:nix-ci:completed:failure"; hk "git push origin HEAD:main" "$S" " ! [rejected]        HEAD -> main (fetch first)"
check "hook: rejected push exits 0" "$RC" 0
check "hook: rejected push lists no runs" "$(none)" none
fx hq8; runs 1 "91:nix-ci:completed:failure"; printf '{"status":"diverged"}' >"$F/compare.json"; hk "git push" "$S"
check "hook: a sha that is not on the branch is not watched" "$(none)" none
fx hq9; printf 'not json' | CI_WATCH_DIR="$F/out" node "$CW" --hook >/dev/null 2>&1; check "hook: bad stdin exits 0" "$?" 0

# ---- hook-LOUD + hook --------------------------------------------------------------
fx hred; runs 1 "61:nix-ci:completed:failure"; printf '{"jobs":[]}' >"$F/run-view-61.json"
hk "git fetch && git push origin HEAD:main" "$S"
check "hook: push of HEAD:main is watched" "$RC" 2
check "hook: red wakes with the summary on stderr" "$(grep -c '^ci-watch RED: o/r@' <<<"$ERR")" 1
check "hook: stdout stays empty" "$OUT" ""
hk "git push" "$S"
check "hook: same sha again is deduped" "$RC" 0
check "hook: dedupe lists runs only once" "$(calls 'run list')" 1

fx hgreen; runs 1 "11:nix-ci:completed:success"; hk "git -C $F/sub push" "$S"
check "hook: green exits 0" "$RC" 0
check "hook: green is silent" "$ERR$OUT" ""
check "hook: git -C <dir> resolves the repo in <dir>" "$(grep -c "^repo view .*@$F/sub\$" "$F/calls.log")" 1

fx hcd; runs 1 "11:nix-ci:completed:success"; hk "cd $F/sub && git push origin main" "$S"
check "hook: cd <dir> && git push resolves the repo in <dir>" "$(grep -c "^repo view .*@$F/sub\$" "$F/calls.log")" 1

fx hwrap; runs 1 "11:nix-ci:completed:success"; hk "sudo env GIT_SSH_COMMAND=x git push" "$S"
check "hook: sudo/env wrappers still count as a push" "$(calls 'run list')" 1
fx hnix; runs 1 "11:nix-ci:completed:success"; hk "nix develop -c git push origin HEAD:main" "$S"
check "hook: nix develop -c wrapper still counts as a push" "$(calls 'run list')" 1
fx hsub; runs 1 "11:nix-ci:completed:success"; hk "(cd $F/sub && git push origin main)" "$S"
check "hook: a push in a subshell counts" "$(calls 'run list')" 1

fx hnone; runs 1; hk "git push" "$S"
check "hook: no runs wakes the session" "$RC" 2
fx hold; OLD=2026-01-01T00:00:00Z runs 1 "92:nix-ci:completed:success"; hk "git push" "$S"
check "hook: only an OLD run on the sha (e.g. a PR run) is not green" "$RC" 2
check "hook: ... it reports NO_RUNS" "$(grep -c '^ci-watch NO_RUNS' <<<"$ERR")" 1
fx hlookup; rm -f "$F/commit.json"; hk "git push" "$S"
check "hook: a lookup error after a landed push wakes (exit 2)" "$RC" 2
check "hook: ... and says WATCH_FAILED" "$(grep -c '^ci-watch WATCH_FAILED' <<<"$ERR")" 1

fx hgh; rm -f "$F/repo.json"; hk "git push" "$S"
check "hook: gh failing after a landed push wakes (exit 2)" "$RC" 2
check "hook: ... WATCH_FAILED" "$(grep -c '^ci-watch WATCH_FAILED' <<<"$ERR")" 1
fx hvar; hk 'cd "$WT" && git push origin HEAD:main' "$S"
check "hook: push in an unresolvable (variable) dir wakes" "$RC" 2
check "hook: ... and says to watch by hand" "$(grep -c 'Watch it by hand' <<<"$ERR")" 1
fx hlab; runs 1 "93:ci:completed:failure"; CI_WATCH_FAKE_REMOTE=git@gitlab.example.com:o/r.git hk "git push" "$S"
check "hook: a self-hosted GitLab remote stays quiet (gitlab.com only)" "$RC" 0
check "hook: ... and asks GitHub nothing" "$(calls 'repo view')" 0
check "hook: ... and asks glab nothing" "$(calls 'api --hostname')" 0
fx hnot; CI_WATCH_FAKE_NOTREPO=1 hk "git push" "$S"
check "hook: not a git checkout stays quiet" "$RC" 0
fx hurl; runs 1 "11:nix-ci:completed:success"; CI_WATCH_FAKE_REMOTE=x hk "git push git@github.com:o/r.git HEAD:main" "$S"
check "hook: a URL remote argument is used as the remote" "$(calls 'run list')" 1

# ---- gitlab ------------------------------------------------------------------------
# glfx <name> [path]  -> fixture F for a gitlab.com project (id 42) at [path] (default o/r)
glfx() {
  fx "$1"; local p=${2:-o/r}
  printf '{"id":42,"path_with_namespace":"%s","default_branch":"main"}' "$p" >"$F/gl-project.json"
  printf '{"id":"%s","title":"fix: thing"}' "$S" >"$F/gl-commit.json"
  printf '[{"new_path":"a.nix"},{"new_path":"b.md"}]' >"$F/gl-diff.json"
}
# glruns <k> <id:status>...  -> gl-pipelines.<k>.json (created_at = now, or $OLD)
glruns() {
  local k=$1; shift
  python3 -I - "$F/gl-pipelines.$k.json" "${OLD:-}" "$@" <<'PY2'
import datetime, json, sys
at = sys.argv[2] or datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
json.dump([{"id": int(i), "source": "push", "status": st, "web_url": f"https://gitlab.com/o/r/-/pipelines/{i}",
            "created_at": at} for i, st in (a.split(":") for a in sys.argv[3:])], open(sys.argv[1], "w"))
PY2
}
GLR=git@gitlab.com:o/r.git
glcalls() { grep -c "^api --hostname gitlab.com projects/42/pipelines?sha=$S" "$F/calls.log" 2>/dev/null || true; }

glfx glgreen; glruns 1 "501:success" "502:skipped"; CI_WATCH_FAKE_REMOTE=$GLR hk "git push origin HEAD:main" "$S"
check "gitlab: green exits 0" "$RC" 0
check "gitlab: green is silent" "$ERR$OUT" ""
check "gitlab: green writes no report" "$(find "$F/out" -type f -name '*.json' | wc -l | tr -d ' ')" 0
check "gitlab: pipelines listed by the full sha" "$(glcalls)" 1
check "gitlab: asks GitHub nothing" "$(calls 'repo view')" 0
check "gitlab: the project is resolved by its encoded path" "$(calls 'api --hostname gitlab.com projects/o%2Fr ')" 1

glfx glred; glruns 1 "511:failed" "512:success"
cat >"$F/gl-jobs-511.json" <<'JSON'
[{"id":701,"name":"lint","stage":"test","status":"failed","allow_failure":false,"web_url":"https://gitlab.com/o/r/-/jobs/701"},
 {"id":702,"name":"flaky","stage":"test","status":"failed","allow_failure":true,"web_url":"https://gitlab.com/o/r/-/jobs/702"},
 {"id":703,"name":"deploy","stage":"deploy","status":"skipped","allow_failure":false,"web_url":"https://gitlab.com/o/r/-/jobs/703"},
 {"id":704,"name":"build","stage":"build","status":"success","allow_failure":false,"web_url":"https://gitlab.com/o/r/-/jobs/704"}]
JSON
{
  printf '2026-11-07T11:00:00.100000Z 00O section_start:1794000000:step_script\r\033[0K\033[0K\033[36;1mExecuting "step_script"\033[0;m\n'
  printf '2026-11-07T11:00:01.000000Z 01O $ make lint\n'
  printf '2026-11-07T11:00:02.000000Z 01E \033[31mlint: a.nix:3: unused binding\033[0m\n'
  printf '2026-11-07T11:00:03.000000Z 00O section_end:1794000003:step_script\r\033[0K\n'
  printf '2026-11-07T11:00:04.000000Z 00O \033[31;1mERROR: Job failed: exit code 2\033[0;m\n'
} >"$F/gl-trace-701.log"
CI_WATCH_FAKE_REMOTE=$GLR hk "git push" "$S"
check "gitlab: red wakes (exit 2)" "$RC" 2
check "gitlab: red summary first line" "$(grep -c "^ci-watch RED: o/r@${S:0:12} \"fix: thing\"" <<<"$ERR")" 1
check "gitlab: red status" "$(j 'd["status"]')" RED
check "gitlab: only the real cause (allow_failure and skipped jobs dropped)" "$(j 'len(d["failures"])')" 1
check "gitlab: job name" "$(j 'd["failures"][0]["job"]')" lint
check "gitlab: job url" "$(j 'd["failures"][0]["job_url"]')" "https://gitlab.com/o/r/-/jobs/701"
check "gitlab: pipeline url" "$(j 'd["failures"][0]["run_url"]')" "https://gitlab.com/o/r/-/pipelines/511"
check "gitlab: conclusion is GitLab's word" "$(j 'd["failures"][0]["conclusion"]')" failed
check "gitlab: no step (jobs have none)" "$(j 'd["failures"][0]["step"]')" None
check "gitlab: same failure keys as GitHub" "$(j 'sorted(d["failures"][0])==sorted(["run_id","workflow","run_url","conclusion","job_id","job","job_url","step","log","commands"])')" True
check "gitlab: error line number is the real one" "$(j 'd["failures"][0]["log"]["error_lines"]')" "[5]"
check "gitlab: stream prefix and ANSI stripped" "$(j 'd["failures"][0]["log"]["lines"][2]["text"]')" "lint: a.nix:3: unused binding"
check "gitlab: section marker stripped" "$(j 'd["failures"][0]["log"]["lines"][3]["text"]')" ""
check "gitlab: rerun command names the job" "$(j 'd["failures"][0]["commands"]["rerun"]')" "glab ci retry 701 -R o/r"
check "gitlab: commit url" "$(j 'd["commit_url"]')" "https://gitlab.com/o/r/-/commit/$S"
check "gitlab: changed files" "$(j '",".join(d["changed_files"])')" "a.nix,b.md"
check "gitlab: summary names the job and its url" "$(grep -c 'FAILED pipeline 511 > lint  https://gitlab.com/o/r/-/jobs/701' <<<"$ERR")" 1
check "gitlab: summary quotes the error line" "$(grep -c 'L5: ERROR: Job failed: exit code 2' <<<"$ERR")" 1
check "gitlab: summary has no gh-only flag" "$(grep -c -- '--log-failed' <<<"$ERR")" 0
CI_WATCH_FAKE_REMOTE=$GLR hk "git push" "$S"
check "gitlab: same sha again is deduped" "$RC" 0
check "gitlab: dedupe lists pipelines only once" "$(glcalls)" 1

glfx glnone; glruns 1; CI_WATCH_FAKE_REMOTE=$GLR hk "git push" "$S"
check "gitlab: no pipeline wakes (exit 2)" "$RC" 2
check "gitlab: ... NO_RUNS" "$(grep -c '^ci-watch NO_RUNS' <<<"$ERR")" 1
glfx glold; OLD=2026-01-01T00:00:00.000Z glruns 1 "521:success"; CI_WATCH_FAKE_REMOTE=$GLR hk "git push" "$S"
check "gitlab: only an OLD pipeline on the sha is NO_RUNS" "$(grep -c '^ci-watch NO_RUNS' <<<"$ERR")" 1
glfx glrun; glruns 1 "531:running"; CEIL=0.2 CI_WATCH_FAKE_REMOTE=$GLR hk "git push" "$S"
check "gitlab: still running wakes (exit 2)" "$RC" 2
check "gitlab: ... STILL_RUNNING naming the pipeline" "$(grep -c 'still running after 0.2s: pipeline 531' <<<"$ERR")" 1
glfx glmanual; glruns 1 "541:manual"; printf '[]' >"$F/gl-jobs-541.json"; CI_WATCH_FAKE_REMOTE=$GLR hk "git push" "$S"
check "gitlab: a pipeline blocked on a manual job wakes without waiting out the ceiling" "$(j 'd["failures"][0]["conclusion"]')" manual
check "gitlab: ... with the pipeline commands (no job)" "$(j 'd["failures"][0]["commands"]["view"]')" "glab ci get -p 541 -R o/r"
glfx glerr; rm -f "$F/gl-project.json"; CI_WATCH_FAKE_REMOTE=$GLR hk "git push" "$S"
check "gitlab: glab failing after a landed push wakes (exit 2)" "$RC" 2
check "gitlab: ... WATCH_FAILED" "$(grep -c '^ci-watch WATCH_FAILED' <<<"$ERR")" 1
glfx glerr2; CI_WATCH_FAKE_REMOTE=$GLR hk "git push" "$S"
check "gitlab: a pipeline lookup error mid-watch is WATCH_FAILED" "$(grep -c '^ci-watch WATCH_FAILED.*HTTP 404' <<<"$ERR")" 1
glfx glfeat; glruns 1 "551:failed"; CI_WATCH_FAKE_REMOTE=$GLR hk "git push origin feature" "$S"
check "gitlab: push to another branch exits 0" "$RC" 0
check "gitlab: ... lists no pipelines" "$(glcalls)" 0
glfx gloff; glruns 1 "561:failed"; printf '{"id":"%s"}' "fedcba9876543210fedcba9876543210fedcba98" >"$F/gl-merge-base.json"
CI_WATCH_FAKE_REMOTE=$GLR hk "git push" "$S"
check "gitlab: a sha that is not on the branch is not watched" "$(glcalls)" 0

glfx glnest g/sub/r; glruns 1 "571:failed"; printf '[]' >"$F/gl-jobs-571.json"
CI_WATCH_FAKE_REMOTE=https://gitlab.com/g/sub/r.git hk "git push" "$S"
check "gitlab: subgroup path is encoded whole" "$(calls 'api --hostname gitlab.com projects/g%2Fsub%2Fr ')" 1
check "gitlab: subgroup red is RED, not WATCH_FAILED" "$(grep -c '^ci-watch RED: g/sub/r@' <<<"$ERR")" 1
check "gitlab: subgroup report lands in the report dir" "$(test -f "$F/out/g--sub--r-$S.json" && echo yes)" yes

glfx glcli; glruns 1 "581:success"; cw --repo gitlab.com/o/r --sha 0123456
check "gitlab cli: --repo gitlab.com/<path> watches through glab" "$RC" 0
check "gitlab cli: short sha expands to the full one" "$(glcalls)" 1
glfx glcli2; glruns 1 "582:failed"; printf '[]' >"$F/gl-jobs-582.json"; CI_WATCH_FAKE_REMOTE=$GLR cw
check "gitlab cli: origin's gitlab.com URL picks glab" "$RC" 1

ff() { node -e 'const {forgeOf}=require(process.argv[1]); const r=forgeOf(process.argv[2]); process.stdout.write(r?(r.forge+(r.path?" "+r.host+" "+r.path:"")):"null")' "$CW" "$1"; }
check "forgeOf: scp" "$(ff git@gitlab.com:g/sub/r.git)" "gitlab gitlab.com g/sub/r"
check "forgeOf: https with user, no .git" "$(ff https://oauth2@gitlab.com/o/r)" "gitlab gitlab.com o/r"
check "forgeOf: ssh with port" "$(ff ssh://git@gitlab.com:22/o/r.git)" "gitlab gitlab.com o/r"
check "forgeOf: trailing slash" "$(ff https://gitlab.com/o/r/)" "gitlab gitlab.com o/r"
check "forgeOf: github" "$(ff git@github.com:o/r.git)" github
check "forgeOf: another host" "$(ff git@gitlab.example.com:o/r.git)" null
check "forgeOf: a lookalike host" "$(ff https://notgitlab.com/o/r.git)" null

# ---- wiring -------------------------------------------------------------------------
w() { python3 -I -c "import json; h=json.load(open('$HOOKS'))['hooks']['PostToolUse'][0]; c=h['hooks'][0]; print($1)"; }
check "wiring: matcher Bash" "$(w 'h["matcher"]')" Bash
check "wiring: asyncRewake" "$(w 'c["asyncRewake"]')" True
check "wiring: if catches git -C and chained pushes" "$(w 'c["if"]')" "Bash(*git*push*)"
# Worst case: the 2700s ceiling, one report (2 commit lookups on GitLab + 5 job lookups + 5 log
# downloads at 30s each = 360s), plus slack. It must stay under the hook timeout.
check "wiring: hook timeout exceeds the worst-case runtime" "$(w 'c["timeout"] >= 2700 + 12*30 + 60')" True

# ---- findPush unit cases -----------------------------------------------------------
fp() { node -e 'const {findPush}=require(process.argv[1]); const r=findPush(process.argv[2],"/w"); process.stdout.write(r?r.dir:"null")' "$CW" "$1"; }
check "findPush: plain" "$(fp 'git push')" /w
check "findPush: -C dir" "$(fp 'git -C ../wt push origin HEAD:main')" /wt
check "findPush: chained, keeps cwd" "$(fp 'git fetch && git rebase origin/main && git push')" /w
check "findPush: absolute git" "$(fp '/usr/bin/git push')" /w
check "findPush: --delete" "$(fp 'git push origin --delete old')" null
check "findPush: :branch delete" "$(fp 'git push origin :old')" null
check "findPush: tags only" "$(fp 'git push --tags')" null
check "findPush: git log mentioning push" "$(fp 'git log --grep push')" null

printf '%d passed, %d failed\n' "$pass" "$fail"
FLOOR=150
[ "$fail" -eq 0 ] && [ "$pass" -ge "$FLOOR" ] || { [ "$pass" -lt "$FLOOR" ] && echo "case floor: $pass < $FLOOR"; exit 1; }
