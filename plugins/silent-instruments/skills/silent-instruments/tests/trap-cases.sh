#!/usr/bin/env bash
# The catalogue, as assertions.
#
# references/catalogue.md claims that specific instruments exit 0 having measured
# nothing. A catalogue of claims nobody re-runs decays into folklore, so every entry
# that can be proven without a network or a credential is proven here — and each case
# asserts BOTH halves:
#
#   TRAP    the naive instrument really does return the wrong answer
#   FIX     the named replacement really does return the right one
#
# The TRAP half is the one that matters. If a toolchain upgrade makes a trap stop
# reproducing, that is not a passing test — it is an entry that must be corrected or
# dropped. Two candidates were already dropped from the catalogue for exactly that
# (a stale-index false dirty, and `git describe` on lightweight tags), which is why
# this file exists.
#
# Scope: shell and git only. The GitHub and API entries (section C) need a network and
# an authenticated gh, and the Nix entries (section D) need a Nix daemon plus one
# specific fleet's option schema — so both are documented but not asserted here. CI must
# stay credential-free and portable.
#
# Run:  bash plugins/silent-instruments/skills/silent-instruments/tests/trap-cases.sh
set -uo pipefail

pass=0; fail=0; skip=0
ok()   { printf '  ok    %-10s %s\n' "$1" "$2"; pass=$((pass+1)); }
bad()  { printf '  FAIL  %-10s %s\n' "$1" "$2"; fail=$((fail+1)); }
skipt(){ printf '  skip  %-10s %s\n' "$1" "$2"; skip=$((skip+1)); }
# eq <id> <what> <want> <got>
eq()   { if [ "$3" = "$4" ]; then ok "$1" "$2"; else bad "$1" "$2 (want=$3 got=$4)"; fi; }

# `SI_NO_ZSH=1` forces the zsh cases to take their skip path, so a zsh-less runner
# (ubuntu-24.04 in CI) can be exercised from a machine that has zsh. Without this the
# skip branches would ship untested — which is the shape of bug this suite is about.
have_zsh() { [ "${SI_NO_ZSH:-}" != "1" ] && command -v zsh >/dev/null 2>&1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

echo "== A. shell =="

# A1 — `local x=$(false)` swallows the status; separate lines do not.
a1_masked() { local x; x=$(false); return 0; }   # placeholder to keep shellcheck calm
got=$(bash -c 'f(){ local x=$(false); echo "$?"; }; f')
eq A1 "local x=\$(false) reports 0 (TRAP)" "0" "$got"
got=$(bash -c 'f(){ local x; x=$(false); echo "$?"; }; f')
eq A1 "declare-then-assign reports 1 (FIX)" "1" "$got"

# A3 — command substitution does not inherit errexit.
got=$(bash -c 'set -e; o=$(false; echo AFTER); echo "$o"')
eq A3 "substitution ignores set -e (TRAP)" "AFTER" "$got"
got=$(bash -c 'set -e; shopt -s inherit_errexit; o=$(false; echo AFTER); echo "$o"' 2>/dev/null; echo "rc=$?")
case "$got" in *rc=1*) ok A3 "inherit_errexit stops it (FIX)" ;; *) bad A3 "inherit_errexit (got $got)" ;; esac

# A4 — no pipefail: the pipeline reports the LAST stage only.
got=$(bash -c 'false | tail -1; echo "$?"')
eq A4 "false|tail reports 0 (TRAP)" "0" "$got"
got=$(bash -c 'set -o pipefail; false | tail -1; echo "$?"')
eq A4 "pipefail reports 1 (FIX)" "1" "$got"

# A5 — pipefail + an early-exiting consumer turns a SUCCESS into 141.
got=$(bash -c 'set -o pipefail; yes hello | grep -q hello; echo "$?"')
if [ "$got" != "0" ]; then ok A5 "SIGPIPE makes a true match look failed (TRAP, got $got)"
else skipt A5 "no SIGPIPE here — producer finished first"; fi
got=$(bash -c 'grep -q hello < <(yes hello | head -100); echo "$?"')
eq A5 "process substitution avoids it (FIX)" "0" "$got"

# A6 — a stale PIPESTATUS read is EMPTY, and echo "$(...)" throws the status away.
# bash: a stale read returns the INTERVENING command's status — 0, i.e. "success".
got=$(bash -c 'false | true; echo marker >/dev/null; echo "[${PIPESTATUS[0]}]"')
eq A6 "bash stale read reports success (TRAP)" "[0]" "$got"
got=$(bash -c 'false | true; echo "[${PIPESTATUS[0]}]"')
eq A6 "bash read on the next line (FIX)" "[1]" "$got"
# zsh: PIPESTATUS does not exist (it is pipestatus) and arrays are 1-indexed, so the
# [0] read is EMPTY no matter how fresh it is. This is the half that produced the
# original misdiagnosis, which is why both shells are asserted.
if have_zsh; then
  got=$(zsh -c 'false | true; echo "[${PIPESTATUS[0]}]"')
  eq A6 "zsh \${PIPESTATUS[0]} empty even when fresh (TRAP)" "[]" "$got"
  got=$(zsh -c 'false | true; echo "[${pipestatus[1]}]"')
  eq A6 "zsh \${pipestatus[1]} is the real one (FIX)" "[1]" "$got"
else
  skipt A6 "zsh not installed"
fi
got=$(bash -c 'echo "[$(exit 7)]" >/dev/null; echo "$?"')
eq A6 "echo \"\$(exit 7)\" reports 0 (TRAP)" "0" "$got"

# A7 — command substitution strips ALL trailing newlines.
printf 'a\nb\n\n\n' > a7.txt
eq A7 "file is 6 bytes" "6" "$(wc -c < a7.txt | tr -d ' ')"
eq A7 "capture is 3 bytes (TRAP)" "3" "$(printf '%s' "$(cat a7.txt)" | wc -c | tr -d ' ')"
cp a7.txt a7b.txt
if cmp -s a7.txt a7b.txt; then ok A7 "cmp compares the bytes (FIX)"; else bad A7 "cmp"; fi

# A8 — grep -c prints 0 AND exits 1.
out=$(grep -c nomatch a7.txt || true); rc_out=$(grep -c nomatch a7.txt >/dev/null; echo $?)
eq A8 "grep -c prints 0" "0" "$out"
eq A8 "…and exits 1 (TRAP)" "1" "$rc_out"

# A9 — diff exit 1 means "differs".
printf 'x\n' > d1; printf 'y\n' > d2
rc=$(diff -q d1 d2 >/dev/null 2>&1; echo $?)
eq A9 "diff on differing files exits 1 (TRAP)" "1" "$rc"
rc=$(cmp -s d1 d2; echo $?)
eq A9 "cmp -s also 1, but means only 'differs' (FIX)" "1" "$rc"

# A10 — find exits 0 having found nothing; -exec does not propagate.
mkdir -p fd && : > fd/present
rc=$(find fd -name 'absent*' >/dev/null; echo $?)
eq A10 "find found nothing, exits 0 (TRAP)" "0" "$rc"
rc=$(find fd -name present -exec false {} \; >/dev/null 2>&1; echo $?)
eq A10 "-exec false still exits 0 (TRAP)" "0" "$rc"
n=$(find fd -name 'absent*' | wc -l | tr -d ' ')
eq A10 "counting detects it (FIX)" "0" "$n"

# A11 — [ -n $EMPTY ] unquoted is TRUE.
rc=$(bash -c 'E=""; if [ -n $E ]; then echo yes; else echo no; fi')
eq A11 "[ -n \$E ] unquoted says yes (TRAP)" "yes" "$rc"
rc=$(bash -c 'E=""; if [ -n "$E" ]; then echo yes; else echo no; fi')
eq A11 "quoted says no (FIX)" "no" "$rc"

# A12 — unset and empty are the same to -z; ${VAR+set} separates them.
rc=$(bash -c 'U2=""; echo "${U+s}${U2+s}"')
eq A12 "\${VAR+set} distinguishes unset from empty (FIX)" "s" "$rc"

# A14 — no trailing newline: read and wc -l both undercount; grep -c '' does not.
printf 'l1\nl2\nl3' > a14.txt
eq A14 "wc -l undercounts (TRAP)" "2" "$(wc -l < a14.txt | tr -d ' ')"
eq A14 "grep -c '' is right (FIX)" "3" "$(grep -c '' < a14.txt | tr -d ' ')"
n=0; while IFS= read -r _; do n=$((n+1)); done < a14.txt
eq A14 "bare while-read drops the last line (TRAP)" "2" "$n"
n=0; while IFS= read -r l || [ -n "$l" ]; do n=$((n+1)); done < a14.txt
eq A14 "…|| [ -n \"\$l\" ] recovers it (FIX)" "3" "$n"

# A16 — zsh omits implicit IFS field splitting, so the loop runs ONCE.
if have_zsh; then
  got=$(zsh -c 'files="one two three"; n=0; for f in $files; do n=$((n+1)); done; echo $n')
  eq A16 "zsh for-in-\$var iterates ONCE (TRAP)" "1" "$got"
  got=$(zsh -c 'printf "one\ntwo\nthree\n" > z.txt; n=0; while IFS= read -r f; do n=$((n+1)); done < z.txt; echo $n')
  eq A16 "while-read iterates 3 times (FIX)" "3" "$got"
  got=$(zsh -c 'files="one two three"; n=0; for f in ${=files}; do n=$((n+1)); done; echo $n')
  eq A16 "\${=var} forces splitting (FIX)" "3" "$got"
  got=$(bash -c 'n=0; for f in nosuch_glob_*.txt; do n=$((n+1)); done; echo $n')
  eq A16 "bash unmatched glob also iterates once (TRAP)" "1" "$got"
else
  skipt A16 "zsh not installed"
fi

# A18 — (( 0 )) returns 1 and kills set -e with NO message.
rc=$(bash -c 'set -e; c=0; (( c )); echo reached' 2>/dev/null; echo "rc=$?")
case "$rc" in *reached*) bad A18 "(( 0 )) did not abort" ;; *) ok A18 "(( 0 )) aborts set -e silently (TRAP)" ;; esac
rc=$(bash -c 'set -e; c=0; (( c )) || true; echo reached')
eq A18 "|| true keeps it alive (FIX)" "reached" "$rc"

# A21 — ps|grep matches itself; pgrep -x does not.
rc=$(ps aux | grep -c 'totally-not-running-xyzzy' || true)
if [ "$rc" -ge 1 ]; then ok A21 "ps|grep matches itself (TRAP, count=$rc)"; else bad A21 "ps|grep count=$rc"; fi
rc=$(pgrep -x 'totally-not-running-xyzzy' >/dev/null 2>&1; echo $?)
eq A21 "pgrep -x says absent (FIX)" "1" "$rc"

echo "== B. git =="
if ! command -v git >/dev/null 2>&1; then
  skipt B "git not installed"
else
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
  git init -q -b main repo && cd repo
  git config user.email t@example.invalid && git config user.name T
  printf 'base\n' > f.txt && git add f.txt && git commit -qm base

  # B1 — checkout -- restores from the INDEX, preserving a staged mistake.
  printf 'STAGED-BAD\n' > f.txt && git add f.txt
  printf 'WORKTREE\n' > f.txt
  git checkout -- f.txt
  eq B1 "checkout -- restores the INDEX (TRAP)" "STAGED-BAD" "$(cat f.txt)"
  git checkout HEAD -- f.txt
  eq B1 "checkout HEAD -- restores HEAD (FIX)" "base" "$(cat f.txt)"
  git reset -q

  # B5 — git diff --quiet is blind to untracked files.
  : > untracked.txt
  rc=$(git diff --quiet; echo $?)
  eq B5 "diff --quiet ignores untracked (TRAP)" "0" "$rc"
  if [ -n "$(git status --porcelain)" ]; then ok B5 "status --porcelain sees it (FIX)"; else bad B5 "porcelain"; fi
  rm -f untracked.txt

  # B6 — git grep only sees tracked files.
  printf 'SECRET_MARKER\n' > untracked2.txt
  rc=$(git grep -l SECRET_MARKER >/dev/null 2>&1; echo $?)
  eq B6 "git grep misses untracked (TRAP)" "1" "$rc"
  rc=$(grep -rl SECRET_MARKER . >/dev/null 2>&1; echo $?)
  eq B6 "plain grep -r finds it (FIX)" "0" "$rc"
  rm -f untracked2.txt

  # B2 / B4 — ranges, and ancestry after a squash merge.
  git checkout -qb feat
  printf 'feat\n' > feat.txt && git add feat.txt && git commit -qm feat
  git checkout -q main
  printf 'main\n' > main.txt && git add main.txt && git commit -qm main
  two=$(git diff --name-only main..feat | sort | tr '\n' ' ' | sed 's/ $//')
  three=$(git diff --name-only main...feat | sort | tr '\n' ' ' | sed 's/ $//')
  eq B2 "A..B includes main's own change (TRAP)" "feat.txt main.txt" "$two"
  eq B2 "A...B is what the branch adds (FIX)" "feat.txt" "$three"

  git merge -q --squash feat >/dev/null 2>&1 || true
  git commit -qm "squash of feat" >/dev/null 2>&1 || true
  rc=$(git merge-base --is-ancestor feat main; echo $?)
  eq B4 "ancestry says NOT merged after squash (TRAP)" "1" "$rc"
  cherry=$(git cherry main feat | awk '{print $1}' | sort -u | tr -d '\n')
  eq B4 "git cherry marks it applied with '-' (FIX)" "-" "$cherry"
  rc=$(git diff --quiet main feat -- feat.txt; echo $?)
  eq B4 "content is identical (FIX)" "0" "$rc"

  # B3 — a bogus pathspec is empty + exit 0.
  rc=$(git log --oneline -- no/such/path >/dev/null 2>&1; echo $?)
  eq B3 "bogus pathspec exits 0 (TRAP)" "0" "$rc"
  rc=$(git ls-files --error-unmatch no/such/path >/dev/null 2>&1; echo $?)
  if [ "$rc" != "0" ]; then ok B3 "ls-files --error-unmatch objects (FIX)"; else bad B3 "ls-files"; fi

  # B8 — a deleted remote branch still resolves until --prune.
  cd "$TMP" && git clone -q repo clone2 >/dev/null 2>&1 && cd clone2
  git checkout -qb doomed && git checkout -q main
  cd "$TMP/repo" && git branch -q doomed 2>/dev/null || true
  cd "$TMP/clone2" && git fetch -q origin 2>/dev/null || true
  cd "$TMP/repo" && git branch -qD doomed 2>/dev/null || true
  cd "$TMP/clone2"
  git fetch -q origin 2>/dev/null || true
  if git rev-parse --verify -q origin/doomed >/dev/null 2>&1; then
    ok B8 "stale origin/* survives a plain fetch (TRAP)"
    git fetch -q --prune origin 2>/dev/null || true
    if git rev-parse --verify -q origin/doomed >/dev/null 2>&1; then bad B8 "--prune did not remove it"; else ok B8 "--prune removes it (FIX)"; fi
  else
    skipt B8 "fixture did not create a stale ref here"
  fi

  # B9 — a shallow clone undercounts history with exit 0.
  cd "$TMP"
  if git clone -q --depth 1 "file://$TMP/repo" shallow >/dev/null 2>&1; then
    full=$(cd repo && git rev-list --count HEAD)
    shal=$(cd shallow && git rev-list --count HEAD)
    if [ "$shal" -lt "$full" ]; then ok B9 "shallow undercounts ($shal vs $full) (TRAP)"; else skipt B9 "clone was not shallow"; fi
    eq B9 "--is-shallow-repository detects it (FIX)" "true" "$(cd shallow && git rev-parse --is-shallow-repository)"
  else
    skipt B9 "shallow clone unsupported here"
  fi
fi

echo
printf -- "-- pass=%s fail=%s skip=%s\n" "$pass" "$fail" "$skip"
[ "$fail" -eq 0 ]
