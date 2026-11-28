#!/usr/bin/env bash
# canon-review step 4, the review's ONE write: render the findings, then dispatch
# kattakath/.github's canon-review-report.yml through the REST dispatches endpoint, which runs
# issue-keeper. Nothing is dispatched unless render.py finished and the state is exactly ok or
# problem. Only state and body are sent: the review is on demand, the scheduled cloud task and
# its heartbeat are retired, and an input the workflow doesn't declare would be refused (422).
#
#   report.sh OUTDIR [--dry-run]    reads OUTDIR/{findings,gates,commits}.json; writes OUTDIR/body.md
#
# REST, not `gh workflow run`: in a claude.ai cloud session that command fails with "HTTP 403:
# GitHub GraphQL is not available from Claude Code sessions" (measured 2026-11-28).
# Exit: 0 dispatched (or the --dry-run plan); 1 render failed or the dispatch failed, and nothing
# was dispatched by this run; 2 usage.
set -u -o pipefail
case ${1:-} in -h | --help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; '' | -*) echo "usage: report.sh OUTDIR [--dry-run]" >&2; exit 2 ;; esac
out=$1 dry=0
[ "${2:-}" = --dry-run ] && dry=1
if [ $# -gt 2 ] || { [ $# -eq 2 ] && [ $dry = 0 ]; }; then echo "usage: report.sh OUTDIR [--dry-run]" >&2; exit 2; fi

here=$(cd "$(dirname "$0")" && pwd)
line=$(python3 -I "$here/render.py" "$out/findings.json" --gates "$out/gates.json" --motto "$out/motto.md" \
  --commits "$out/commits.json" --out "$out/body.md" | head -1) || { echo "report.sh: render failed; nothing dispatched" >&2; exit 1; }
state=${line#state=}
case $state in ok | problem) ;; *) echo "report.sh: render gave no state ('$line'); nothing dispatched" >&2; exit 1 ;; esac

set -- api -X POST repos/kattakath/.github/actions/workflows/canon-review-report.yml/dispatches \
  -f ref=main -f "inputs[state]=$state" -f "inputs[body]=$(cat "$out/body.md")"
if [ "$dry" = 1 ]; then
  echo "plan: gh api -X POST …/canon-review-report.yml/dispatches ref=main state=$state body=$out/body.md"
  exit 0
fi
gh "$@" || { echo "report.sh: the dispatch failed" >&2; exit 1; }
echo "report.sh: dispatched state=$state" >&2
