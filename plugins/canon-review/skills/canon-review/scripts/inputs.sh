#!/usr/bin/env bash
# canon-review inputs, read LIVE (never a copy), with only git, curl, jq and python3:
#   - the fleet repo list and the § Motto rubric, from kattakath/nix-config main;
#   - each GitHub fleet repo, cloned (blob-less) into OUTDIR/work/<owner>_<repo>;
#   - its default-branch commits since the window start.
# Window start, with NO cap (the review is on demand; runs can be weeks apart):
#   --since ISO8601   that time;  --since <sha>   that commit's committer date (any fleet repo);
#   neither           the last SUCCESSFUL canon-review-report run in kattakath/.github minus 2 h.
#                     With none (or the API unreadable) it stops with exit 3: pass --since.
#
#   inputs.sh OUTDIR [--since ISO8601|SHA]
#       writes OUTDIR/motto.md, OUTDIR/commits.json and OUTDIR/window.json
# window.json carries the size up front: {"since", "source", "commits", "changed_lines"}.
# commits.json: [{"repo", "branch", "dir", "commits": [{"sha", "subject"}]}]; a non-GitHub fleet
# entry carries "skipped": "<why>". $GH_TOKEN, if set, authenticates the one API read.
# Exit: 0 written; 1 a read failed; 2 usage, or a --since that is neither a time nor a sha;
#       3 no window start known (pass --since).
set -u -o pipefail

usage() { echo "usage: inputs.sh OUTDIR [--since ISO8601|SHA]" >&2; exit 2; }
case ${1:-} in -h | --help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; '' | -*) usage ;; esac
out=$1
shift
since=
while [ $# -gt 0 ]; do
  case $1 in
    --since) [ $# -ge 2 ] || usage; since=$2; shift 2 ;;
    *) usage ;;
  esac
done
mkdir -p "$out/work" || exit 1
die() { echo "inputs.sh: $*" >&2; exit "${RC:-1}"; }
# The ONE api.github.com read is the window lookup on kattakath/.github. Per-repo work goes
# through git only: in a claude.ai cloud session the proxy answers 403 for a repo that is not a
# session source (measured 2026-11-28), while anonymous clones of public repos work. A token
# that is set but rejected (a cloud GH_TOKEN can be) is retried anonymously.
api() {
  local url="https://api.github.com/$1"
  if [ -n "${GH_TOKEN:-}" ]; then
    curl -fsSL -H "Accept: application/vnd.github+json" -H "Authorization: Bearer $GH_TOKEN" "$url" 2>/dev/null && return 0
  fi
  curl -fsSL -H "Accept: application/vnd.github+json" "$url"
}
raw() { curl -fsSL "https://raw.githubusercontent.com/kattakath/nix-config/main/$1"; }

list=$(raw .claude/skills/fleet-doctor/fleet-repos.txt) || die "cannot read the fleet list from kattakath/nix-config"
repos=$(printf '%s\n' "$list" | grep -v -E '^[[:space:]]*(#|$)')
[ -n "$repos" ] || die "the fleet list is empty"

# Read it whole first: awk stops at the next heading, and under pipefail a curl cut off by
# that early exit (SIGPIPE) would read as a failed fetch.
canon=$(raw claude/CLAUDE.md) || die "cannot read claude/CLAUDE.md from kattakath/nix-config"
printf '%s\n' "$canon" | awk '/^## Motto/{on=1} on&&/^## /&&!/^## Motto/{exit} on' >"$out/motto.md"
grep -q '^| \*\*look first\*\*' "$out/motto.md" || die "§ Motto has no handle table (did the heading or the table move?)"

# Clone (or refresh) every GitHub fleet repo first: a --since <sha> resolves against them.
while IFS= read -r entry; do
  case $entry in
    github.com/*/*)
      r=${entry#github.com/}
      d=$out/work/$(printf '%s' "$r" | tr '/' '_')
      [ -d "$d/.git" ] || git clone -q --filter=blob:none "https://github.com/$r.git" "$d" 2>/dev/null || die "cannot clone $r"
      git -C "$d" fetch -q origin 2>/dev/null || die "cannot fetch $r"
      ;;
  esac
done <<<"$repos"

# The window start. No cap: the review is on demand, and a cap would skip commits silently.
#   --since ISO      that time
#   --since <sha>    that commit's committer date, in whichever fleet repo has it
#   (nothing)        the last successful report run minus 2 h; with none, exit 3: pass --since
case $since in
  '')
    last=$(api "repos/kattakath/.github/actions/workflows/canon-review-report.yml/runs?status=success&per_page=1" 2>/dev/null |
      jq -r '.workflow_runs[0].created_at // empty' 2>/dev/null)
    # shellcheck disable=SC2086 # $last is empty or one timestamp; empty must pass no argument
    since=$(python3 -I "$(dirname "$0")/window.py" $last 2>/dev/null) ||
      RC=3 die "no prior successful report run to start from (or the API is unreadable); pass --since ISO8601 or --since <sha>"
    src="last successful report run, minus 2 h"
    ;;
  *[!0-9a-f]* | ?????? | ????? | ???? | ??? | ?? | ?) src=override ;; # not a sha: an ISO time
  *)
    at=
    for d in "$out"/work/*/; do
      at=$(git -C "$d" show -s --format=%cI "$since^{commit}" 2>/dev/null) && break
    done
    [ -n "$at" ] || RC=2 die "--since $since is neither an ISO time nor a commit in any fleet repo"
    src="commit $since"
    since=$at
    ;;
esac

echo "[" >"$out/commits.json"
first=1
lines=0
while IFS= read -r entry; do
  [ "$first" = 1 ] || echo "," >>"$out/commits.json"
  first=0
  case $entry in
    github.com/*/*)
      r=${entry#github.com/}
      d=$out/work/$(printf '%s' "$r" | tr '/' '_')
      b=$(git -C "$d" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null) || die "$r has no default branch"
      b=${b#origin/}
      n=$(git -C "$d" log --shortstat --format= --since="$since" "origin/$b" | awk '{for(i=1;i<NF;i++) if ($(i+1) ~ /^(insertion|deletion)/) s+=$i} END {print s+0}')
      lines=$((lines + n))
      git -C "$d" log --format='%H%x09%s' --since="$since" "origin/$b" |
        jq -R -s --arg r "$r" --arg b "$b" --arg dir "$d" \
          '{repo: $r, branch: $b, dir: $dir, commits: [split("\n")[] | select(length > 0) | split("\t") | {sha: .[0], subject: (.[1:] | join("\t"))}]}' \
          >>"$out/commits.json" || die "cannot list commits of $r"
      ;;
    *) jq -n --arg r "$entry" '{repo: $r, skipped: "not a GitHub repo; review it by hand", commits: []}' >>"$out/commits.json" ;;
  esac
done <<<"$repos"
echo "]" >>"$out/commits.json"
jq -e 'type == "array"' "$out/commits.json" >/dev/null || die "commits.json did not come out as a JSON array"
ncommits=$(jq '[.[].commits | length] | add // 0' "$out/commits.json")
# The size up front, so a weeks-long window is a decision before the reading starts.
jq -n --arg s "$since" --arg why "$src" --argjson c "$ncommits" --argjson l "$lines" \
  '{since: $s, source: $why, commits: $c, changed_lines: $l}' >"$out/window.json"
echo "inputs.sh: $ncommits commit(s), $lines changed line(s), in $(jq length "$out/commits.json") repo(s) since $since ($src)" >&2
