#!/usr/bin/env bash
# Gate: userscript-lab rides Claude in Chrome only. Fails on any CDP / page-lab residue,
# and on a SKILL.md that does not state the lost guarantee verbatim (on ONE line).
set -u
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
self="$here/$(basename "$0")"
status=0

pattern='chrome-devtools|chrome-lab|kapture|9222|evaluate_script|take_snapshot|remote-debugging|PAGE_LAB_CHROME|\.\./\.\./references/'
sentence='No `document-start` proof is available on this rail: Claude in Chrome injects only after load. Its `computer` clicks and key presses are trusted (`isTrusted: true`, measured 2026-11-14). Verify by installing in Violentmonkey and checking with Claude in Chrome; say which checks ran.'

if [ ! -d "$root/skills" ]; then
  echo "no-cdp: FAIL — $root/skills does not exist" >&2
  exit 1
fi

# This file names every banned literal, so it is the one file excluded from the scan.
hits=$(grep -rnE "$pattern" "$root" | grep -vF "$self:" || true)
if [ -n "$hits" ]; then
  echo "no-cdp: FAIL — CDP / page-lab residue:" >&2
  printf '%s\n' "$hits" >&2
  status=1
fi

for skill in userscript-author site-redesign; do
  f="$root/skills/$skill/SKILL.md"
  if [ ! -f "$f" ]; then
    echo "no-cdp: FAIL — missing $f" >&2
    status=1
  elif ! grep -qF -- "$sentence" "$f"; then
    echo "no-cdp: FAIL — $skill/SKILL.md lacks the guarantee sentence (verbatim, one line)" >&2
    status=1
  fi
done

[ "$status" -eq 0 ] && echo "no-cdp: OK"
exit "$status"
