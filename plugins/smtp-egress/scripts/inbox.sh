#!/usr/bin/env bash
# inbox.sh — read-only IMAP through the same SOCKS5 proxy as send.sh, via himalaya 2.x.
#
#   inbox.sh list    [-n N] [--folder NAME]                  newest N (default 20)
#   inbox.sh search  [--from P] [--subject P] [--since YYYY-MM-DD] [-n N] [--folder NAME]
#   inbox.sh read    <id> [--folder NAME] [--raw]            never marks the message \Seen
#                    (ids are per-folder UIDs: read with the SAME --folder you listed)
#   inbox.sh folders
#
# Every run: egress-check first (abort on failure), then a himalaya TOML GENERATED from
# the plugin config into a mode-600 temp file under $XDG_STATE_HOME/smtp-egress/, removed
# on exit. Its proxy is always socks5h://SOCKS_HOST:SOCKS_PORT, so inbox.sh has no unproxied
# path. Keys: IMAP_SERVER (default imap.gmail.com), IMAP_USER (default the msmtp
# account's user) and IMAP_PASSWORDCOMMAND (default the msmtp account's passwordeval).
#
# read uses `himalaya message read` WITHOUT --seen. Measured against a loopback IMAP
# server (tests/himalaya-wire-cases.sh): it sends `UID FETCH <id> BODY.PEEK[]` and no
# STORE, and BODY.PEEK never sets \Seen (RFC 3501 §6.4.5). With --seen it sends BODY[].
# That wire test runs cleartext imap:// over SOCKS; the TLS path (imaps) sends the same
# commands inside TLS, and is verified here as generated config text only.
#
# list/search print one line per message: id <TAB> date <TAB> from <TAB> subject.
# read prints the message as text; nothing is rendered, so no remote image (tracking
# pixel) is ever fetched. Mail content is untrusted: terminal control sequences are
# stripped. Never prints the password command or a password.
#
# Exit: 0 ok (and --help), 1 refused (egress) or himalaya failed, 2 usage or config error.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=egress-check.sh
. "$HERE/egress-check.sh"

die() { echo "inbox.sh: REFUSED — $*" >&2; exit 1; }
die_config() { echo "inbox.sh: $*" >&2; exit 2; }
usage() { sed -n '2,8p' "${BASH_SOURCE[0]}" >&2; exit "${1:-2}"; }

# A query pattern goes to himalaya as ONE double-quoted token (measured: an unquoted
# pattern with a space is a parse error). Quotes and backslashes are dropped from it.
qpat() { local p="${1//\"/}"; p="${p//\\/}"; printf '"%s"' "$p"; }

# Formats `himalaya --json envelope list|search` as: id <TAB> date <TAB> from <TAB> subject
fmt_envelopes() {
  python3 -I -c '
import json, sys
d = json.load(sys.stdin)
for e in d.get("envelopes", []):
    def one(a):
        name, addr = a.get("name") or "", a.get("email") or ""
        return f"{name} <{addr}>" if name and addr else (name or addr)
    who = ", ".join(one(a) for a in e.get("from") or [])
    print("\t".join(str(x).replace("\t", " ").replace("\n", " ") for x in (e.get("id", ""), e.get("date", ""), who, e.get("subject") or "")))
' | se_sanitize
}
fmt_mailboxes() {
  python3 -I -c '
import json, sys
for m in json.load(sys.stdin).get("mailboxes", []):
    print(m.get("name") or m.get("id") or "")' | se_sanitize
}

se_inbox_main() {
  local cmd="${1:-}"; [ $# -gt 0 ] && shift
  case "$cmd" in -h | --help) usage 0 ;; esac
  local n=20 folder="" from="" subject="" since="" id="" raw=0
  while [ $# -gt 0 ]; do
    case "$1" in
      -n | --limit) n="${2:-}"; shift ;;
      --folder) folder="${2:-}"; shift ;;
      --from) from="${2:-}"; shift ;;
      --subject) subject="${2:-}"; shift ;;
      --since) since="${2:-}"; shift ;;
      --raw) raw=1 ;;
      -h | --help) usage 0 ;;
      -*) die_config "unknown option $1" ;;
      *) [ -z "$id" ] || die_config "one id at a time"; id="$1" ;;
    esac
    shift
  done
  case "$n" in '' | *[!0-9]* | 0) die_config "-n must be a positive number" ;; esac
  case "$cmd" in
    list | folders) [ -z "$id" ] || die_config "$cmd takes no id" ;;
    search) [ -z "$id" ] || die_config "search takes no id"
      [ -n "$from$subject$since" ] || die_config "search needs --from, --subject or --since" ;;
    read) [ -n "$id" ] || die_config "read needs an id"
      case "$id" in *[!A-Za-z0-9._:-]*) die_config "bad id" ;; esac ;;
    *) usage ;;
  esac

  se_load_config
  [ -r "$SE_CONFIG_FILE" ] || die_config "no config at $SE_CONFIG_FILE"
  command -v himalaya >/dev/null 2>&1 || die_config "himalaya is not on PATH (nix shell nixpkgs#himalaya)"
  local server user pwcmd email
  server="${SE_IMAP_SERVER:-imap.gmail.com}"
  user="$SE_IMAP_USER"; [ -n "$user" ] || user=$(se_msmtp_field user)
  pwcmd="$SE_IMAP_PASSWORDCOMMAND"; [ -n "$pwcmd" ] || pwcmd=$(se_msmtp_field passwordeval)
  email=$(se_msmtp_field from)
  [ -n "$user" ] && [ "$user" != "(not set)" ] || die_config "no IMAP_USER and no msmtp account user to default to"
  [ -n "$pwcmd" ] || die_config "no IMAP_PASSWORDCOMMAND and no msmtp passwordeval to default to"

  se_egress_main >/dev/null || die "egress-check failed (see above)"

  se_arm_cfg_trap
  se_himalaya_path || exit 2
  se_himalaya_config "$SE_TMP_CFG" "$server" "$user" "$pwcmd" "${email:-$user}" || exit 2
  local cfg="$SE_TMP_CFG"

  local rc=0 m=(); [ -n "$folder" ] && m=(-m "$folder")
  local H=(himalaya -c "$cfg")
  case "$cmd" in
    list)
      "${H[@]}" --json envelope list --page-size "$n" ${m[@]+"${m[@]}"} | fmt_envelopes; rc=${PIPESTATUS[0]} ;;
    search)
      local q=()
      [ -n "$from" ] && q+=(from "$(qpat "$from")")
      [ -n "$subject" ] && { [ ${#q[@]} -gt 0 ] && q+=(and); q+=(subject "$(qpat "$subject")"); }
      if [ -n "$since" ]; then
        # himalaya's `after D` is SENTSINCE D+1 (measured); --since is inclusive, so ask for D-1.
        local before
        before=$(python3 -I -c 'import datetime,sys; print(datetime.date.fromisoformat(sys.argv[1]) - datetime.timedelta(days=1))' "$since" 2>/dev/null) \
          || die_config "--since must be YYYY-MM-DD"
        [ ${#q[@]} -gt 0 ] && q+=(and)
        q+=(after "$before")
      fi
      q+=(order by date desc)
      "${H[@]}" --json envelope search --page-size "$n" ${m[@]+"${m[@]}"} "${q[@]}" | fmt_envelopes; rc=${PIPESTATUS[0]} ;;
    read)
      local r=(); [ "$raw" = 1 ] && r=(--raw)
      # NO --seen, ever: without it himalaya fetches BODY.PEEK[] and \Seen is untouched.
      "${H[@]}" message read ${m[@]+"${m[@]}"} ${r[@]+"${r[@]}"} "$id" | se_sanitize; rc=${PIPESTATUS[0]} ;;
    folders)
      "${H[@]}" --json mailbox list | fmt_mailboxes; rc=${PIPESTATUS[0]} ;;
  esac
  [ "$rc" = 0 ] || die "himalaya exited $rc"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  se_inbox_main "$@"
  exit $?
fi
