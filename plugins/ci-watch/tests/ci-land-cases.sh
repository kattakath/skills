#!/usr/bin/env bash
# scripts/ci-land against REAL git and a local bare remote, so "nothing was pushed" is checked on
# the remote itself; only gitleaks is stubbed (STUB_LEAK=1 makes it find something).
# Prints "ci-land: <pass> passed, <fail> failed"; exit 0 only when all pass.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
CL=${CL:-$HERE/../scripts/ci-land}
T=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$T"' EXIT
export GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1 XDG_CONFIG_HOME="$T/xdg"
git config --global user.email t@t
git config --global user.name t
git config --global init.defaultBranch main
mkdir -p "$T/bin" "$T/xdg/ci-land"
printf '#!/usr/bin/env bash\necho "gitleaks $*" >>"%s/gitleaks.log"\n[ "${STUB_LEAK:-0}" = 1 ] && { echo "leak: REDACTED" >&2; exit 1; }\nexit 0\n' "$T" >"$T/bin/gitleaks"
chmod +x "$T/bin/gitleaks"
export PATH="$T/bin:$PATH"
printf '# client literals\nacme-secret-client\n' >"$T/xdg/ci-land/literals"
unset CI_LAND_LITERALS
pass=0 fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL ci-land: %s\n  got:  %s\n  want: %s\n' "$1" "$2" "$3"; fi; }

fresh() { # a bare remote with one commit, and a clone W
  rm -rf "$T/remote.git" "$T/w"
  git init -q --bare "$T/remote.git"
  git clone -q "$T/remote.git" "$T/seed" 2>/dev/null
  git -C "$T/seed" commit -q --allow-empty -m init
  git -C "$T/seed" push -q origin HEAD:main
  rm -rf "$T/seed"
  git clone -q "$T/remote.git" "$T/w"
}
remote_main() { git -C "$T/remote.git" rev-parse main; }
commit() { # file text message
  printf '%s\n' "$2" >"$T/w/$1"
  git -C "$T/w" add -A && git -C "$T/w" commit -q -m "$3"
}
land() { # args... -> RC OUT ERR
  local o e
  o=$(mktemp) e=$(mktemp)
  "$CL" -C "$T/w" "$@" >"$o" 2>"$e"
  RC=$?
  OUT=$(cat "$o") ERR=$(cat "$e")
  rm -f "$o" "$e"
}

# contract surface
out=$("$CL" --help 2>/dev/null); rc=$?
check "--help: stdout, exit 0" "$rc:${out%%$'\n'*}" "0:usage: ci-land [-C DIR] [--dry-run]"
"$CL" --bogus 2>/dev/null; check "unknown option: exit 2" "$?" 2

# clean land: pushes the gated sha to main
fresh; commit a.txt hello "add a"
before=$(remote_main); land
check "clean: exit 0, remote main is the local HEAD" "$RC:$(remote_main)" "0:$(git -C "$T/w" rev-parse HEAD)"
check "clean: gitleaks scanned origin/main..HEAD" "$(grep -c -- '--log-opts=origin/main..HEAD' "$T/gitleaks.log")" 1
rm -f "$T/gitleaks.log"

# nothing to land
land; check "nothing to land: exit 0, says so" "$RC:$(printf '%s' "$ERR" | grep -c 'nothing to land')" "0:1"

# dirty tree: refused, nothing pushed, nothing scanned
fresh; commit a.txt hello "add a"; before=$(remote_main); echo dirty >"$T/w/a.txt"
land; check "dirty tree: exit 4, remote unchanged, no gate ran" "$RC:$(remote_main):$(test -f "$T/gitleaks.log" && echo ran || echo none)" "4:$before:none"

# gitleaks finds something: refused, nothing pushed
fresh; commit a.txt hello "add a"; before=$(remote_main)
STUB_LEAK=1 land; check "gitleaks leak: exit 3, remote unchanged" "$RC:$(remote_main)" "3:$before"

# a client literal in an added line / in a commit message: refused, pattern never printed
fresh; commit a.txt "for ACME-Secret-Client only" "add a"; before=$(remote_main)
land; check "literal in diff: exit 3, remote unchanged" "$RC:$(remote_main)" "3:$before"
check "literal in diff: counts only, the pattern never printed" "$(printf '%s%s' "$OUT" "$ERR" | grep -ci 'acme-secret-client')" 0
fresh; commit a.txt hello "fix for acme-secret-client"; before=$(remote_main)
land; check "literal in a commit message: exit 3, remote unchanged" "$RC:$(remote_main)" "3:$before"

# the literal list fails closed
fresh; commit a.txt hello "add a"; before=$(remote_main)
CI_LAND_LITERALS="$T/none" land; check "no literals file: exit 3, remote unchanged" "$RC:$(remote_main)" "3:$before"
printf '# nothing here\n' >"$T/empty"
CI_LAND_LITERALS="$T/empty" land; check "patternless list without the marker: exit 3" "$RC:$(remote_main)" "3:$before"
printf '(\n' >"$T/badre"
CI_LAND_LITERALS="$T/badre" land; check "a broken pattern (grep exit 2): exit 3, remote unchanged" "$RC:$(remote_main)" "3:$before"
printf '# ci-land: no literal patterns\n' >"$T/marked"
CI_LAND_LITERALS="$T/marked" land; check "list marked as none on purpose: lands" "$RC:$(remote_main)" "0:$(git -C "$T/w" rev-parse HEAD)"

# the repo's own check: run with the changed files; a failure or a tree change refuses
fresh; mkdir -p "$T/w/.ci-land"
printf '#!/usr/bin/env bash\necho "$@" >"%s/check.args"\nexit "${STUB_CHECK:-0}"\n' "$T" >"$T/w/.ci-land/check"
chmod +x "$T/w/.ci-land/check"; git -C "$T/w" add -A; git -C "$T/w" commit -q -m "add check"
git -C "$T/w" push -q origin HEAD:main
commit b.nix "{ }" "add b"; before=$(remote_main)
STUB_CHECK=1 land; check "repo check fails: exit 1, remote unchanged" "$RC:$(remote_main)" "1:$before"
check "repo check got the changed files" "$(cat "$T/check.args")" "b.nix"
land; check "repo check passes: lands" "$RC:$(remote_main)" "0:$(git -C "$T/w" rev-parse HEAD)"

# dry-run: a plan, no fetch, no push; SSH remote when workflow files changed
fresh; git -C "$T/w" remote set-url origin https://github.com/o/r.git
mkdir -p "$T/w/.github/workflows"; commit .github/workflows/ci.yml "on: push" "ci"
land --dry-run
check "dry-run: exit 0, workflow change plans the SSH remote" "$RC:$(printf '%s' "$OUT" | grep -c 'git push git@github.com:o/r.git <sha>:main')" "0:1"
fresh; git -C "$T/w" remote set-url origin https://github.com/o/r.git; commit a.txt hello "add a"
land --dry-run
check "dry-run: no workflow change plans origin" "$(printf '%s' "$OUT" | grep -c 'git push origin <sha>:main')" 1
git -C "$T/w" remote set-url origin "$T/remote.git"; before=$(remote_main)
land --dry-run; check "dry-run: remote unchanged" "$RC:$(remote_main)" "0:$before"

# rebase onto a moved remote, then land (never a force push)
fresh; git clone -q "$T/remote.git" "$T/other"
printf 'x\n' >"$T/other/o.txt"; git -C "$T/other" add -A; git -C "$T/other" commit -q -m other; git -C "$T/other" push -q origin HEAD:main
rm -rf "$T/other"; commit a.txt hello "add a"
land; check "moved remote: rebased and landed on top" "$RC:$(git -C "$T/remote.git" rev-list --count main)" "0:3"

# worktree NAME: a branch off origin/main under .claude/worktrees
fresh; land worktree feat
check "worktree: prints its path, branch created off origin/main" "$RC:$OUT:$(git -C "$T/w" rev-parse feat)" "0:$T/w/.claude/worktrees/feat:$(git -C "$T/w" rev-parse origin/main)"

echo "ci-land: $pass passed, $fail failed"
[ "$fail" = 0 ]
