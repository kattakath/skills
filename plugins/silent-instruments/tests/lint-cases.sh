#!/usr/bin/env bash
# Case suite for scripts/silent-instrument-lint.js.
#
# Three halves, because each fails differently:
#   must-FLAG   a rule that stopped matching is a silent regression — the advisory
#               channel goes quiet and nothing reports that it did
#   must-QUIET  THE important half. This hook is enabled in every repo, so a rule that
#               fires on ordinary work trains the reader to ignore the channel, and an
#               ignored channel protects nothing. Noise is worse than a gap here.
#   never-throw an uncaught error exits 0, which disarms every rule above without
#               saying so — the exact failure class this plugin is about
#
# Run:  bash plugins/silent-instruments/tests/lint-cases.sh
set -uo pipefail

LINT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/silent-instrument-lint.js"
pass=0; fail=0

# rc <json> -> exit code
rc() { printf '%s' "$1" | node "$LINT" >/dev/null 2>&1; echo $?; }
# msg <json> -> stderr text
msg() { printf '%s' "$1" | node "$LINT" 2>&1 >/dev/null; }

bash_json() { python3 -c 'import json,sys;print(json.dumps({"tool_name":"Bash","tool_input":{"command":sys.argv[1]}}))' "$1"; }

# flag <id> <label> <command>
flag() {
  local j; j=$(bash_json "$3")
  local got; got=$(rc "$j")
  local text; text=$(msg "$j")
  if [ "$got" = "2" ] && printf '%s' "$text" | grep -q "\[$1\]"; then
    printf '  ok    FLAG  %-4s %s\n' "$1" "$2"; pass=$((pass+1))
  else
    printf '  FAIL  FLAG  %-4s %s (exit=%s, matched=%s)\n' "$1" "$2" "$got" \
      "$(printf '%s' "$text" | grep -o "\[$1\]" | head -1)"; fail=$((fail+1))
  fi
}
# quiet <label> <command>
quiet() {
  local got; got=$(rc "$(bash_json "$2")")
  if [ "$got" = "0" ]; then printf '  ok    QUIET      %s\n' "$1"; pass=$((pass+1))
  else printf '  FAIL  QUIET      %s (exit=%s: %s)\n' "$1" "$got" \
    "$(msg "$(bash_json "$2")" | tr '\n' ' ' | cut -c1-100)"; fail=$((fail+1)); fi
}

echo "== must FLAG — each rule fires on the shape that was measured =="
flag A16 "unquoted for-in-\$var"        'for f in $files; do echo "$f"; done'
flag A16 "braced unquoted for-in"       'for f in ${files}; do echo "$f"; done'
flag A6  "PIPESTATUS without pipefail"  'a | b; echo "${PIPESTATUS[0]}"'
flag A4  "pipeline status via \$? "     'make build | tail -5; if [ $? -ne 0 ]; then exit 1; fi'
flag A21 "ps aux | grep liveness"       'ps aux | grep mydaemon'
flag A20 "curl -s without -f"           'curl -s https://api.example.com/v1/thing | jq .name'
flag A10 "find -exec"                   'find . -name "*.sh" -exec shellcheck {} \;'
flag A1  "local x=\$(...)"              'f(){ local out=$(git rev-parse HEAD); echo "$out"; }'
flag A14 "wc -l counting"               'n=$(wc -l < items.txt); echo "$n"'
flag B4  "merge-base --is-ancestor"     'git merge-base --is-ancestor feature main'
flag B4  "branch --merged"              'git branch --merged main'
flag B5  "git diff --quiet"             'git diff --quiet && echo clean'
flag B1  "git checkout -- path"         'git checkout -- src/app.js'
flag C5  "gh api without --paginate"    'gh api repos/o/r/issues --jq ".[].number"'
flag C11 "jq -r without -e"             'gh pr view 1 --json title | jq -r .title'
flag D2  "forced sandbox, no --rebuild" 'nix build --option sandbox true .#checks.aarch64-darwin.project-gate'
flag D2  "flake check, forced sandbox"  'nix flake check --option sandbox true'

echo "== must stay QUIET — the corrected forms, and ordinary work =="
quiet "quoted expansion in for"          'for f in "$file"; do echo "$f"; done'
quiet "while IFS= read -r"               'while IFS= read -r f; do echo "$f"; done < list.txt'
quiet "explicit glob loop"               'for f in ./*.txt; do echo "$f"; done'
quiet "pipefail present with PIPESTATUS" 'set -o pipefail; a | b; echo "${PIPESTATUS[0]}"'
quiet "pgrep -x"                         'pgrep -x mydaemon'
quiet "curl -fsS"                        'curl -fsS https://api.example.com/v1/thing'
quiet "curl POST with -f"                'curl -fsS -X POST -d @body https://api.example.com/v1'
quiet "find piped to xargs -0 -r"        'find . -name "*.sh" -print0 | xargs -0 -r shellcheck'
quiet "declare then assign"              'f(){ local out; out=$(git rev-parse HEAD); echo "$out"; }'
quiet "grep -c for counting"             'n=$(grep -c "" items.txt); echo "$n"'
quiet "git cherry for content"           'git cherry main feature'
quiet "status --porcelain for clean"     'test -z "$(git status --porcelain)"'
quiet "git checkout HEAD -- path"        'git checkout HEAD -- src/app.js'
quiet "gh api --paginate"                'gh api --paginate repos/o/r/issues'
quiet "gh api graphql"                   'gh api graphql -f query="{viewer{login}}"'
quiet "gh api POST is not a list read"   'gh api -X POST repos/o/r/issues -f title=x'
quiet "jq -e"                            'gh pr view 1 --json title | jq -e -r .title'
quiet "plain ls"                         'ls -la /tmp'
quiet "nix build"                        'nix build --no-link .#checks.aarch64-darwin.formatting'
quiet "git commit"                       'git commit -m "a message with for in it"'
quiet "a pipeline with no status read"   'cat f.txt | sort | uniq'
quiet "forced sandbox WITH --rebuild"    'nix build --rebuild --option sandbox true .#checks.aarch64-darwin.project-gate'
quiet "forced sandbox with --check"      'nix-build --check --option sandbox true ./default.nix'
quiet "sandbox false is the default"     'nix build --option sandbox false .#checks.aarch64-darwin.project-gate'
quiet "reading the sandbox setting"      'nix config show sandbox'
quiet "plain flake check"                'nix flake check --all-systems --no-build'

echo "== must never throw, and must ignore non-Bash tools =="
for j in \
  '' \
  'not json at all' \
  '{}' \
  '{"tool_name":"Bash"}' \
  '{"tool_name":"Bash","tool_input":{}}' \
  '{"tool_name":"Bash","tool_input":{"command":""}}' \
  '{"tool_name":"Bash","tool_input":{"command":null}}' \
  '{"tool_name":"Write","tool_input":{"command":"for f in $x; do :; done"}}' \
  '{"tool_name":"Edit","tool_input":{"file_path":"/tmp/a","new_string":"for f in $x; do :; done"}}'
do
  got=$(rc "$j")
  label="$(printf '%s' "$j" | cut -c1-44)"; [ -z "$label" ] && label="(empty stdin)"
  if [ "$got" = "0" ]; then printf '  ok    SAFE       %s\n' "$label"; pass=$((pass+1))
  else printf '  FAIL  SAFE       %s (exit=%s)\n' "$label" "$got"; fail=$((fail+1)); fi
done

echo "== the advisory must name the cross-check, not just the problem =="
text=$(msg "$(bash_json 'for f in $files; do echo "$f"; done')")
for want in "differently shaped" "catalogue.md" "while IFS= read -r"; do
  if printf '%s' "$text" | grep -qi -- "$want"; then
    printf '  ok    TEXT       mentions %s\n' "$want"; pass=$((pass+1))
  else printf '  FAIL  TEXT       missing %s\n' "$want"; fail=$((fail+1)); fi
done

echo
printf -- "-- pass=%s fail=%s\n" "$pass" "$fail"
[ "$fail" -eq 0 ]
