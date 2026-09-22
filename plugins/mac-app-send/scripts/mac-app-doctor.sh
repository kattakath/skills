#!/usr/bin/env bash
# Preflight for a macOS computer-use send. Answers, in ONE shot, the questions a
# session would otherwise spend several tool calls probing:
#   is the app installed, what is its bundle id, is it running, and is a
#   display-scope escalation going to be needed for attachments (it always is).
#
# Pure metadata reads (mdfind/mdls). Sends no input, needs no automation grant,
# and changes nothing.
#
# Usage:  mac-app-doctor.sh "WhatsApp" [...more apps]
set -uo pipefail

# BSD vs GNU: the fleet puts GNU coreutils ahead of /usr/bin on PATH, and GNU
# `stat` has no -f. Absolute path so this is the BSD one regardless.
STAT=/usr/bin/stat

if [ "$#" -eq 0 ]; then
  echo "usage: mac-app-doctor.sh <App Name> [App Name...]" >&2
  exit 64
fi

status=0

for app in "$@"; do
  echo "── ${app}"

  path=$(mdfind -onlyin /Applications -onlyin "$HOME/Applications" \
           "kMDItemKind == 'Application' && kMDItemFSName == '${app}.app'" 2>/dev/null | head -1)
  if [ -z "$path" ] && [ -d "/Applications/${app}.app" ]; then
    path="/Applications/${app}.app"
  fi

  if [ -z "$path" ]; then
    echo "   installed : NO — not found in /Applications or ~/Applications"
    echo "   next      : confirm the exact app name with list_apps"
    status=1
    echo
    continue
  fi

  bundle=$(mdls -name kMDItemCFBundleIdentifier -raw "$path" 2>/dev/null)
  [ "$bundle" = "(null)" ] && bundle=""
  if [ -z "$bundle" ]; then
    bundle=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" \
              "$path/Contents/Info.plist" 2>/dev/null || true)
  fi

  running=no
  pgrep -x "$app" >/dev/null 2>&1 && running=yes

  echo "   installed : yes"
  echo "   path      : $path"
  echo "   bundle id : ${bundle:-UNKNOWN}"
  echo "   running   : $running"
  echo "   modified  : $($STAT -f '%Sm' -t '%Y-%m-%d' "$path" 2>/dev/null || echo '?')"
  echo
done

cat <<'NEXT'
── next calls
   request_access   [<App>], clipboardWrite
   open_application <App>
   app_screenshot   -> confirm the RIGHT conversation (1:1 vs group) before typing

── attachments always need display scope
   The file chooser is com.apple.appkit.xpc.openAndSavePanelService, a separate
   process no app grant covers. Go straight to request_full_control when you
   reach it; do NOT request_access on the panel service — it can never be granted.
NEXT

exit $status
