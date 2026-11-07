#!/bin/sh
# chrome-devtools-mcp launcher for Chrome on an Android device (physical or emulator) —
# "blind" browsing over CDP: take_snapshot's accessibility tree, click/fill by uid,
# evaluate_script. No screenshots, no coordinates (that is mobile-mcp's lane).
#
# Android Chrome serves CDP on the abstract socket `chrome_devtools_remote` whenever
# the device has USB debugging on — there is no in-app toggle (Firefox's "Remote
# debugging via USB" speaks Mozilla RDP instead, which this server cannot use).
# `adb forward` exposes that socket on a Mac port, and the server attaches with
# --browser-url. Measured 2026-11-07 against Chrome 157 on an API 35 AVD:
# list_pages → take_snapshot → click {uid} → evaluate_script all worked.
#
# WHY THE FORWARD IS BEST-EFFORT: chrome-devtools-mcp connects LAZILY (measured: it
# starts against a dead port and fails only on the first tool call). So a session that
# starts with no device still gets a working server once someone runs the forward
# below — no restart needed. Failing the launch instead would show a red server in
# every session without a phone attached.
#
# Port 9223, not 9222: page-lab's desktop Chromium owns 9222, and both run at once.
#
# Configuration (environment):
#   ANDROID_SERIAL      which device, when more than one is attached (adb's own variable)
#   ANDROID_CDP_PORT    Mac-side port (default 9223)
#   ANDROID_CDP_SOCKET  device socket (default chrome_devtools_remote; another Chromium
#                       browser names its own `*_devtools_remote` — list them with
#                       `adb shell cat /proc/net/unix | grep devtools_remote`)
set -eu

port="${ANDROID_CDP_PORT:-9223}"
socket="${ANDROID_CDP_SOCKET:-chrome_devtools_remote}"

adb="$(command -v adb 2>/dev/null || true)"
[ -n "$adb" ] || [ ! -x /opt/homebrew/bin/adb ] || adb=/opt/homebrew/bin/adb

if [ -z "$adb" ]; then
  echo "android-chrome: adb not found; tools will fail until 'adb forward tcp:$port localabstract:$socket' runs" >&2
elif ! "$adb" forward "tcp:$port" "localabstract:$socket" >/dev/null 2>&1; then
  # No device, several devices without ANDROID_SERIAL, or an unauthorized one.
  echo "android-chrome: no forward yet (no single authorized device); run 'adb forward tcp:$port localabstract:$socket' later — the server connects lazily" >&2
fi

# --no-performance-crux keeps traced URLs from being sent to Google; keep both flags.
exec npx -y chrome-devtools-mcp@1.12.0 --browser-url="http://127.0.0.1:$port" \
  --no-usage-statistics --no-performance-crux "$@"
