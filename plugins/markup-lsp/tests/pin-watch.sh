#!/usr/bin/env bash
# Keep ONE GitHub issue in step with lock-parity.py (run by .github/workflows/markup-lsp-pin.yml).
#   pins differ  -> open the issue (assigned to $ASSIGNEE, so someone is notified), or
#                   comment on the open one only when its last word differs
#   pins match   -> close the open issue, if any
#   check broken -> exit 1 and write nothing
# Env: GH_REPO (owner/name, read by gh itself), ASSIGNEE (optional login).
# Usage: pin-watch.sh <nix-config>/flake.lock [<our flake.lock>]
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
TITLE="markup-lsp: nixpkgs pin lags nix-config"

rc=0
msg=$(python3 -I "$here/lock-parity.py" "$@") || rc=$?
echo "$msg"
case "$rc" in 0 | 3) ;; *)
  echo "::error file=plugins/markup-lsp/tests/lock-parity.py::lock-parity.py failed (exit $rc); the pin watcher is blind until it is fixed"
  exit 1 ;;
esac

list=$(gh issue list --state open --limit 200 --json number,title) || { echo "::error::gh issue list failed"; exit 1; }
open=$(jq -r --arg t "$TITLE" 'map(select(.title == $t)) | .[0].number // empty' <<<"$list") || exit 1

if [ "$rc" = 0 ]; then
  [ -n "$open" ] && { gh issue close "$open" --comment "Parity is back. $msg" || exit 1; }
  exit 0
fi

if [ -z "$open" ]; then
  body="$msg

Opened by .github/workflows/markup-lsp-pin.yml, which closes this issue once the pins match."
  args=(issue create --title "$TITLE" --body "$body")
  [ -n "${ASSIGNEE:-}" ] && args+=(--assignee "$ASSIGNEE")
  gh "${args[@]}" || exit 1
  exit 0
fi

last=$(gh issue view "$open" --json body,comments --jq '([.body] + [.comments[].body]) | last') || exit 1
case "$last" in
  *"$msg"*) echo "issue #$open already says this" ;;
  *) gh issue comment "$open" --body "Still lagging. $msg" || exit 1 ;;
esac
