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
# WHY THE FORWARD IS REMOVED ON EXIT: the forward makes the phone's LOGGED-IN Chrome an
# unauthenticated CDP endpoint on 127.0.0.1 — any local process can drive it — and an
# adb forward outlives the process that made it. So this script does not `exec` the
# server: it waits for it and then removes the forward (EXIT trap, so a signal or a failed
# step still cleans up), unless another launcher on the SAME port is still running (it
# would lose its endpoint mid-session). Each launcher registers its pid in a per-user,
# per-port directory under $TMPDIR; dead pids there are pruned, so one SIGKILL'd launcher
# (the only exit no trap sees) leaves a forward that the next session's exit removes.
# Only a forward that still points at OUR socket is removed, each with `-s <its serial>`,
# so a hand-made forward to anything else stays. adb has no process-bound forward;
# `--no-rebind` (first launcher owns it) lost because the owner's exit would cut a
# sibling session's endpoint. Tests: tests/attach-cases.sh.
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

child=
adb="$(command -v adb 2>/dev/null || true)"
[ -n "$adb" ] || [ ! -x /opt/homebrew/bin/adb ] || adb=/opt/homebrew/bin/adb

reg="${TMPDIR:-/tmp}/android-chrome-attach-$(id -u)"
if ! { { mkdir -m 700 "$reg" 2>/dev/null || [ -d "$reg" ]; } && mkdir -p "$reg/$port" && : >"$reg/$port/$$"; }; then
  echo "android-chrome: cannot register in $reg; the forward will be removed at exit even if another session uses it" >&2
fi

# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() {
  rm -f "$reg/$port/$$"
  # Another live launcher on this port shares the forward; leave it for the last one out.
  for f in "$reg/$port"/*; do
    [ -e "$f" ] || continue
    if kill -0 "${f##*/}" 2>/dev/null; then return 0; fi
    rm -f "$f"
  done
  [ -n "$adb" ] || return 0
  "$adb" forward --list 2>/dev/null | while read -r serial local remote; do
    if [ "$local $remote" = "tcp:$port localabstract:$socket" ]; then
      "$adb" -s "$serial" forward --remove "tcp:$port" >/dev/null 2>&1 || true
    fi
  done
}
# Both traps go in BEFORE the forward exists: a signal during startup must still run
# cleanup (an untrapped TERM kills the shell without the EXIT trap).
trap cleanup EXIT
trap 'if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null; else exit 143; fi' HUP INT TERM

if [ -z "$adb" ]; then
  echo "android-chrome: adb not found; tools will fail until 'adb forward tcp:$port localabstract:$socket' runs" >&2
elif ! "$adb" forward "tcp:$port" "localabstract:$socket" >/dev/null 2>&1; then
  # No device, several devices without ANDROID_SERIAL, or an unauthorized one.
  echo "android-chrome: no forward yet (no single authorized device); run 'adb forward tcp:$port localabstract:$socket' later — the server connects lazily" >&2
fi

# --no-performance-crux keeps traced URLs from being sent to Google; keep both flags.
# The server inherits stdin/stdout, so MCP traffic is unchanged by not exec-ing it.
npx -y chrome-devtools-mcp@1.12.0 --browser-url="http://127.0.0.1:$port" \
  --no-usage-statistics --no-performance-crux "$@" &
child=$!
status=0
wait "$child" || status=$?
# A trapped signal interrupts the first wait; wait again so cleanup runs after the child.
if kill -0 "$child" 2>/dev/null; then wait "$child" || status=$?; fi
exit "$status"
