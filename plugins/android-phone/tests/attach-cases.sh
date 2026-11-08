#!/usr/bin/env bash
# android-chrome launcher cases: after every way a session can end, NO adb forward to the
# CDP socket and NO listener on its port remain. A forward left behind is the phone's
# logged-in Chrome served as unauthenticated CDP on 127.0.0.1 — the bug these pin.
#
# Fakes only — no device is touched. The fake adb keeps its forward table in a file, and
# its `forward` really binds the port (a python listener) so "nothing listens" is measured,
# not inferred. The fake npx stands in for chrome-devtools-mcp: it sleeps, or exits with
# FAKE_NPX_EXIT. TMPDIR is a scratch dir, so a real launcher on this machine is invisible.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
launch="$(dirname "$here")/scripts/android-chrome-attach.sh"
scratch=$(mktemp -d)
pids=()
finish() {
  rc=$?
  for p in "${pids[@]:-}"; do [ -z "$p" ] || kill "$p" 2>/dev/null || true; done
  for f in "$scratch"/state/listener.*; do [ ! -e "$f" ] || kill "$(cat "$f")" 2>/dev/null || true; done
  rm -rf "$scratch"
  exit "$rc"
}
trap finish EXIT
mkdir -p "$scratch/bin" "$scratch/state" "$scratch/tmp"

cat >"$scratch/bin/adb" <<'ADB'
#!/bin/sh
# Fake adb: forward table in $FAKE_ADB_STATE/forwards ("<serial> <local> <remote>").
set -eu
st="$FAKE_ADB_STATE"; touch "$st/forwards"
serial="${ANDROID_SERIAL:-}"
if [ "${1:-}" = -s ]; then serial="$2"; shift 2; fi
pick() {
  [ -n "$serial" ] && return 0
  set -- $FAKE_ADB_DEVICES
  [ "$#" -eq 1 ] || { echo "adb: error: more than one device/emulator, or none" >&2; exit 1; }
  serial="$1"
}
listening() { python3 -c 'import socket,sys; s=socket.socket(); sys.exit(s.connect_ex(("127.0.0.1",int(sys.argv[1]))) != 0)' "$1"; }
[ "${1:-}" = forward ] || { echo "fake adb: unsupported: $*" >&2; exit 2; }
shift
case "${1:-}" in
  --list) cat "$st/forwards" ;;
  --remove)
    pick; local="$2"; port="${local#tcp:}"
    grep -q "^$serial $local " "$st/forwards" || { echo "adb: error: listener '$local' not found" >&2; exit 1; }
    grep -v "^$serial $local " "$st/forwards" >"$st/f.new" || true; mv "$st/f.new" "$st/forwards"
    echo "$serial $local" >>"$st/removes"
    if [ -e "$st/listener.$port" ]; then kill "$(cat "$st/listener.$port")"; rm -f "$st/listener.$port"; fi ;;
  *)
    pick; local="$1"; remote="$2"; port="${local#tcp:}"
    grep -v " $local " "$st/forwards" >"$st/f.new" || true; mv "$st/f.new" "$st/forwards"
    echo "$serial $local $remote" >>"$st/forwards"
    if [ ! -e "$st/listener.$port" ]; then
      python3 -c 'import socket,sys,time; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(("127.0.0.1",int(sys.argv[1]))); s.listen(); time.sleep(600)' "$port" </dev/null >/dev/null 2>&1 &
      echo $! >"$st/listener.$port"
      i=0; until listening "$port"; do i=$((i + 1)); [ "$i" -lt 100 ] || exit 1; sleep 0.05; done
    fi
    [ -z "${FAKE_ADB_FORWARD_DELAY:-}" ] || sleep "$FAKE_ADB_FORWARD_DELAY" ;;
esac
ADB
cat >"$scratch/bin/npx" <<'NPX'
#!/bin/sh
[ -z "${FAKE_NPX_EXIT:-}" ] || exit "$FAKE_NPX_EXIT"
exec sleep 300
NPX
chmod +x "$scratch/bin/adb" "$scratch/bin/npx"

port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
sock=chrome_devtools_remote
pass=0
ok() { pass=$((pass + 1)); echo "ok   $1"; }
fail() { echo "FAIL $1" >&2; exit 1; }
reset() { rm -f "$scratch"/state/*; rm -rf "$scratch"/tmp/*; }
# exec: a backgrounded `( run … )` then has the LAUNCHER's pid, so signals reach it.
run() { exec env -i PATH="$scratch/bin:/usr/bin:/bin" TMPDIR="$scratch/tmp" FAKE_ADB_STATE="$scratch/state" \
  FAKE_ADB_DEVICES="${devices:-fake-serial-a}" ANDROID_CDP_PORT="$port" "$@" "${TEST_SH:-sh}" "$launch"; }
start() { (run "$@") </dev/null 2>/dev/null & pids+=("$!"); last=$!; }
ours() { n=$(grep -c " tcp:$port localabstract:$sock\$" "$scratch/state/forwards" 2>/dev/null) || true; echo "${n:-0}"; }
listening() { python3 -c 'import socket,sys; s=socket.socket(); sys.exit(s.connect_ex(("127.0.0.1",int(sys.argv[1]))) != 0)' "$port"; }
# Up = forward listed, port bound, and the server started (so the launcher is mid-session).
up() { i=0; until [ "$(ours)" -eq 1 ] && listening && pgrep -P "$last" -f "^sleep 300" >/dev/null; do
  i=$((i + 1)); [ "$i" -lt 100 ] || fail "launcher never made the forward"; sleep 0.05; done; }
gone() { # $1 = case name; zero forwards for our socket AND nothing listening on the port
  [ "$(ours)" -eq 0 ] || fail "$1: forward still listed: $(cat "$scratch/state/forwards")"
  if listening; then fail "$1: something still listens on the port"; fi
}
stop() { kill "-$1" "$2"; wait "$2" 2>/dev/null || true; }

reset; set +e; (run FAKE_NPX_EXIT=0) </dev/null 2>/dev/null; rc=$?; set -e
[ "$rc" -eq 0 ] || fail "normal exit status $rc"; gone "normal exit"; ok "server exits 0: forward removed, port closed"

reset; set +e; (run FAKE_NPX_EXIT=3) </dev/null 2>/dev/null; rc=$?; set -e
[ "$rc" -eq 3 ] || fail "crash status $rc, want 3"; gone "server crash"; ok "server crashes (exit 3): status kept, forward removed"

for sig in TERM HUP; do
  reset; start; up; srv=$(pgrep -P "$last" -f "^sleep 300"); stop "$sig" "$last"; gone "SIG$sig"
  if kill -0 "$srv" 2>/dev/null; then fail "SIG$sig: server outlived the launcher"; fi
  ok "launcher gets SIG$sig mid-session: server stopped, forward removed, port closed"
done

reset; start FAKE_ADB_FORWARD_DELAY=1; i=0; until [ "$(ours)" -eq 1 ]; do i=$((i + 1)); [ "$i" -lt 100 ] || fail "no forward"; sleep 0.05; done
if pgrep -P "$last" -f "^sleep 300" >/dev/null; then fail "startup case: server already up, so this tests nothing"; fi
stop TERM "$last"; gone "SIGTERM during startup"; ok "launcher gets SIGTERM while the forward is being made: forward removed"

reset; start; a=$last; up; start; b=$last; sleep 0.3
stop TERM "$a"; if [ "$(ours)" -ne 1 ] || ! listening; then fail "first of two exits: sibling lost its endpoint"; fi
stop TERM "$b"; gone "last of two"; ok "two sessions: the first exit keeps the forward, the last removes it"

reset; start; k=$last; up; orphan=$(pgrep -P "$k" -f "^sleep 300" || true); kill -KILL "$k"; wait "$k" 2>/dev/null || true
[ -z "$orphan" ] || kill "$orphan" 2>/dev/null || true
[ "$(ours)" -eq 1 ] || fail "SIGKILL: expected the untrappable leak to be visible"
start; up; stop TERM "$last"; gone "after SIGKILL"
ok "SIGKILL leaks until the next session: its dead registry entry is pruned and that exit removes it"

reset; printf 'fake-serial-a tcp:1 localabstract:%s\nfake-serial-a tcp:%s localabstract:other_socket\n' "$sock" "$((port + 1))" >"$scratch/state/forwards"
start; up; stop TERM "$last"; gone "foreign"
[ "$(grep -c . "$scratch/state/forwards")" -eq 2 ] || fail "foreign forwards touched: $(cat "$scratch/state/forwards")"
ok "forwards on another port or socket are left alone"

reset; devices="fake-serial-a fake-serial-b" start ANDROID_SERIAL=fake-serial-b; up; stop TERM "$last"
gone "serial"
[ "$(cat "$scratch/state/removes")" = "fake-serial-b tcp:$port" ] || fail "remove not scoped: $(cat "$scratch/state/removes")"
ok "two devices + ANDROID_SERIAL: remove is issued with -s for that serial"

reset; set +e; err=$(devices="fake-serial-a fake-serial-b"; run FAKE_NPX_EXIT=0 2>&1 </dev/null); rc=$?; set -e
[ "$rc" -eq 0 ] || fail "no-forward exit status $rc"
case "$err" in *"no forward yet"*) ;; *) fail "no-forward message: $err" ;; esac
[ ! -e "$scratch/state/removes" ] || fail "removed a forward it never made"; gone "no device"
ok "no single device: starts anyway, says so, removes nothing"

[ "$pass" -ge 10 ] || { echo "expected >= 10 cases, ran $pass" >&2; exit 1; }
echo "android-chrome launcher: $pass cases passed"
