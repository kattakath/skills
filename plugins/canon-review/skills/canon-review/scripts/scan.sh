#!/usr/bin/env bash
# canon-review leak gates over the window, mechanically (no model), on the clones inputs.sh made:
#   gitleaks  over each repo's window commits. Resolved from PATH, else a PINNED release download
#             verified by sha256 (a cloud session has no gitleaks). Unobtainable means "failed",
#             and the body says so; it is never a silent pass.
#   literals  the client-literal patterns over the window's messages and added lines, ONLY if
#             the list is reachable ($CI_LAND_LITERALS, else ~/.config/ci-land/literals, the
#             config ci-watch's ci-land reads). In a cloud session it isn't: "skipped".
#
#   scan.sh OUTDIR     reads OUTDIR/commits.json, writes OUTDIR/gates.json
#                      {"gitleaks": clean|found|failed, "literals": clean|found|failed|skipped}
# Counts only: a finding's text or a pattern is never printed. Exit: 0 written (whatever the
# result); 1 unreadable inputs; 2 usage.
set -u -o pipefail
case ${1:-} in -h | --help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; esac
[ $# -eq 1 ] || { echo "usage: scan.sh OUTDIR" >&2; exit 2; }
out=$1
jq -e 'type == "array"' "$out/commits.json" >/dev/null 2>&1 || { echo "scan.sh: no readable $out/commits.json" >&2; exit 1; }

# The ONE gitleaks resolver (PATH, else the sha256-pinned release): a GENERATED copy of
# ci-watch's scripts/gitleaks-resolve.sh, kept identical by build-index.py --check.
# shellcheck source=gitleaks-resolve.sh
. "$(cd "$(dirname "$0")" && pwd)/gitleaks-resolve.sh" || { echo "scan.sh: cannot load gitleaks-resolve.sh" >&2; exit 1; }
if gl_resolve "$out/bin"; then leaks() { gl "$@"; }; else leaks() { return 127; }; fi

lit=${CI_LAND_LITERALS:-${XDG_CONFIG_HOME:-$HOME/.config}/ci-land/literals}
pat=$(mktemp) || exit 1
trap 'rm -f "$pat"' EXIT
if [ -r "$lit" ] && grep -v -E '^[[:space:]]*(#|$)' "$lit" >"$pat" 2>/dev/null && [ -s "$pat" ]; then literals=clean; else literals=skipped; fi
gl=clean

while IFS=$'\t' read -r _repo dir oldest; do
  [ -n "$oldest" ] && [ -d "$dir" ] || continue
  range="$oldest^..HEAD"
  git -C "$dir" rev-parse -q --verify "$oldest^" >/dev/null 2>&1 || range=HEAD # the repo's first commit
  git -C "$dir" checkout -q --detach "origin/$(git -C "$dir" symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||')" 2>/dev/null
  # --exit-code 42: gitleaks exits 1 on an ERROR too (measured), so a leak needs its own code.
  leaks git --exit-code 42 --log-opts="$range" --redact --no-banner "$dir" >/dev/null 2>&1
  case $? in 0) ;; 42) gl=found ;; *) [ "$gl" = found ] || gl=failed ;; esac
  if [ "$literals" != skipped ]; then
    # Two passes, so neither filter eats the other's lines: the messages, then the added lines.
    n=$({ git -C "$dir" log --format=%B "$range"; git -C "$dir" log -p --format= "$range" | grep '^+' | grep -v '^+++'; } 2>/dev/null |
      grep -c -i -E -f "$pat" 2>/dev/null)
    rc=$?
    if [ "$rc" -ge 2 ]; then [ "$literals" = found ] || literals=failed; elif [ "${n:-0}" -gt 0 ]; then literals=found; fi
  fi
done < <(jq -r '.[] | select((.commits | length) > 0) | [.repo, .dir, .commits[-1].sha] | @tsv' "$out/commits.json")

jq -n --arg g "$gl" --arg l "$literals" '{gitleaks: $g, literals: $l}' >"$out/gates.json"
echo "scan.sh: gitleaks $gl; client literals $literals" >&2
