#!/bin/sh
# browser.sh <profile> {up|headed|down|status|print-argv|mcp} — the ONE launcher for every
# page-lab browser profile (page-lab/profile@1; docs/page-lab-vnext-design.md §4.3).
#
#   attach profiles (daily)  exec scripts/chrome-devtools-attach.sh, UNCHANGED. That script's
#                            two-mode probe and its "$@" pass-through are documented trap
#                            avoidance; routing it through a closed argv would make its own
#                            WHY comments false. The .mcp.json `chrome-devtools` entry still
#                            names that script directly, so attach behaviour is byte-identical.
#                            page-lab never launches, stops or relaunches the operator's
#                            browser: headed/down refuse here.
#   dedicated (lab, lab-diag) page-lab's own browser on a derived dir, over a PIPE (no TCP
#                            debugging port).
#       up | headed          start the chrome-devtools CLI daemon (headless | headed)
#       down | status        stop / report it
#       mcp                  exec a stdio chrome-devtools-mcp server — the `chrome-lab` entry
#       print-argv [headed]  the dry run the no-evasion test asserts on
#
# Upstream defaults --headless AND --categoryExtensions to true for a launched browser, so the
# argv spells both [F-CLI-HEADLESS-DEFAULT].
#
# WHY NO "$@" PASS-THROUGH in dedicated mode. This is the only place a dedicated argv is
# turned into a process, and the argv itself comes from lib/profiles.mjs#dedicatedArgv, built
# from a CLOSED set (profile record, headless flag, workspace) — the same function the gate's
# handoff relaunch calls, so headless and headed launches cannot drift. A forwarded argument
# is how a --proxyServer or a --chromeArg would get in. Extra arguments are refused, not
# dropped silently.
#
# The CLI daemon refuses to start in a group/other-writable runtime dir and listens on a
# unix socket there (same uid only). Its session id is the profile name hex-encoded, so
# up/down/status from any shell find the same daemon.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
lib="$here/lib/profiles.mjs"
cdm="chrome-devtools-mcp@1.12.0"

die() {
  code="$1"
  shift
  printf 'browser.sh: %s\n' "$*" >&2
  exit "$code"
}

[ "$#" -ge 2 ] || die 2 "usage: browser.sh <profile> {up|headed|down|status|print-argv [headed]|mcp}"
profile="$1"
verb="$2"
shift 2

mode="$(node "$lib" mode "$profile")" || exit 2

if [ "$mode" = attach ]; then
  [ "$#" -eq 0 ] || die 2 "attach: no extra arguments"
  case "$verb" in
    up | mcp) exec "$here/chrome-devtools-attach.sh" ;;
    status) exec "$here/devtools-doctor.sh" ;;
    print-argv)
      printf '%s\n' "attach: argv is assembled by $here/chrome-devtools-attach.sh at launch"
      exit 0
      ;;
    headed | down) die 2 "$profile is the operator's own browser: page-lab never launches or stops it" ;;
    *) die 2 "unknown verb: $verb" ;;
  esac
fi

session="$(node "$lib" session "$profile")"
export CD4A_INTERNAL_DAEMON_SESSION_ID="$session"
# The CLI otherwise checks the npm registry on every call.
export CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1
cli() { npx -y -p "$cdm" chrome-devtools "$@"; }
daemon_up() { cli status 2>/dev/null | grep -q 'daemon is running'; }

variant=headless
case "$verb" in
  down | status)
    [ "$#" -eq 0 ] || die 2 "dedicated: extra arguments are refused (closed argv): $*"
    if [ "$verb" = down ]; then cli stop; else cli status; fi
    exit $?
    ;;
  headed) variant=headed ;;
  print-argv)
    if [ "${1:-}" = headed ]; then
      variant=headed
      shift
    fi
    ;;
  up | mcp) ;;
  *) die 2 "unknown verb: $verb" ;;
esac
[ "$#" -eq 0 ] || die 2 "dedicated: extra arguments are refused (closed argv): $*"

# One flag per line → positional parameters. set -f so a glob character in a path stays
# literal; IFS=newline so a space in a path (Application Support, an .app bundle) does not
# split it. lib/profiles.mjs refuses any token containing a newline.
flags="$(node "$lib" argv "$profile" "$variant")" || exit 2
set -f
old_ifs="$IFS"
IFS='
'
# shellcheck disable=SC2086
set -- $flags
IFS="$old_ifs"
set +f

if [ "$verb" = print-argv ]; then
  printf '%s\n' "$@"
  exit 0
fi

# `chrome-devtools start` RESTARTS a running daemon, which would kill a run mid-page. So an
# `up` on a running daemon is a no-op, and switching headless <-> headed is an explicit
# `down` first (page-lab-gate handoff does exactly that, after checking the lock is ours).
if [ "$verb" != mcp ] && daemon_up; then
  if [ "$verb" = up ]; then
    printf '%s\n' "browser.sh: $profile daemon already running" >&2
    exit 0
  fi
  die 12 "$profile daemon is running — browser.sh $profile down first"
fi

# Chromium allows one process per profile dir; a HEADED second opener silently hands off to
# the live one instead of failing. Refuse before launching (exit 12, as page-lab-gate does).
#
# For `mcp` this is the ONLY check there is: Claude Code spawns one chrome-lab server per
# session, and the server launches Chromium lazily, at its first tool call — after which no
# hook of ours runs. So a live lock at spawn means another session's chrome-lab (or a gate run)
# owns the dir, and this server must not start: exit non-zero, one line, no tools. A second
# session spawned BEFORE the first one's first tool call still collides later, as a launch
# error; README states the one-session limit.
lock="$(node "$lib" lock "$profile")"
case "$lock" in
  held*)
    if [ "$verb" = mcp ]; then die 12 "$profile in use by pid ${lock#held }; one chrome-lab per machine"; fi
    die 12 "profile $profile is locked ($lock) — one owner per dir"
    ;;
  foreign*) die 12 "profile $profile is locked ($lock) — one owner per dir" ;;
esac

dir="$(node "$lib" dir "$profile")"
ws="$(node "$lib" workspace "$profile")"
umask 077
mkdir -p "$(dirname "$dir")" "$ws"
[ -d "$dir" ] || mkdir -m 0700 "$dir"
chmod 0700 "$dir"
# Cookies at rest are effectively plaintext (mock keychain); keep them out of backups.
# Best-effort: tmutil can refuse (no Time Machine, a path it will not exclude).
if [ "$(uname -s)" = Darwin ] && command -v tmutil >/dev/null 2>&1; then
  tmutil addexclusion "$dir" >/dev/null 2>&1 || true
fi

case "$verb" in
  mcp) exec npx -y "$cdm" "$@" ;;
  *) cli start "$@" ;;
esac
