#!/usr/bin/env bash
# doctor.sh [--read] — one-shot preflight for mail-cloak. Reads and measures; changes
# nothing except that egress-check may start wireproxy when WIREPROXY_CONFIG is set, and
# stale himalaya-*.toml temp configs (older than 1 h, left by a killed run) are removed.
#
# Reports: msmtp / wireproxy on PATH (+ versions), the config file and its mode (must be
# 600), the msmtprc and the account's from (WARN when it is a send-as alias of the login
# user), the egress-check verdict, then the SOCKS port (after egress-check, which may
# have just started wireproxy), and whether a header-check PASS is recorded for this
# exact account + SOCKS endpoint.
#
# Rows are tagged [send], [read] or [both]. The summary says send-ready and read-ready.
# Exit: 0 when send-ready (WARN rows never fail); with --read, 0 when read-ready, so a
# missing msmtp does not block reading. 1 otherwise.
# Never prints a secret: paths, host, port and the account's from only. from/user are
# read from the msmtprc file; passwordeval is never run.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=egress-check.sh
. "$HERE/egress-check.sh"

mode="send"
case "${1:-}" in --read) mode="read" ;; "") ;; *) echo "usage: doctor.sh [--read]" >&2; exit 2 ;; esac
send_ok=1 read_ok=1
row() { printf '   %-14s: %s\n' "$1" "$2"; }
# bad <tag> <name> <text>: tag says which readiness the failure breaks.
bad() {
  case "$1" in send) send_ok=0 ;; read) read_ok=0 ;; *) send_ok=0; read_ok=0 ;; esac
  row "$2" "FAIL [$1] — $3"
}
warn() { row "$1" "WARN — $2"; }

mode_of() {
  python3 -I -c 'import os, sys; print(format(os.stat(sys.argv[1]).st_mode & 0o777, "o"))' "$1" 2>/dev/null
}

echo "── tools"
have_msmtp=0
if command -v msmtp >/dev/null 2>&1; then
  have_msmtp=1
  row msmtp "$(msmtp --version 2>/dev/null | head -1)"
else
  bad send msmtp "not on PATH (nix shell nixpkgs#msmtp)"
fi
if command -v wireproxy >/dev/null 2>&1; then
  row wireproxy "$(wireproxy --version 2>/dev/null | head -1)"
else
  row wireproxy "not on PATH (optional: any SOCKS5 proxy works)"
fi
if command -v himalaya >/dev/null 2>&1; then
  row himalaya "$(himalaya --version 2>/dev/null | head -1)"
else
  read_ok=0
  row himalaya "not on PATH [read] (inbox.sh and the probe read-back need it; nix shell nixpkgs#himalaya)"
fi
for t in curl python3 node; do
  if command -v "$t" >/dev/null 2>&1; then row "$t" "yes"; else bad both "$t" "not on PATH"; fi
done

echo "── config"
se_load_config
if [ -r "$SE_CONFIG_FILE" ]; then
  m=$(mode_of "$SE_CONFIG_FILE")
  [ -n "${SE_CONFIG_LEGACY:-}" ] && warn legacy "using the pre-rename config $SE_CONFIG_FILE; move the directory to ${XDG_CONFIG_HOME:-$HOME/.config}/mail-cloak/"
  if [ "$m" = 600 ]; then row config "$SE_CONFIG_FILE (mode 600)"
  else bad both config "$SE_CONFIG_FILE has mode ${m:-?}; chmod 600 it"; fi
else
  bad both config "missing: $SE_CONFIG_FILE (see the skill's config section)"
fi
if [ -n "$SE_MSMTP_CONFIG" ] && [ -r "$SE_MSMTP_CONFIG" ]; then
  row msmtprc "$SE_MSMTP_CONFIG (mode $(mode_of "$SE_MSMTP_CONFIG"))"
else
  bad send msmtprc "MSMTP_CONFIG unset or unreadable"
fi
if [ -z "$SE_MSMTP_ACCOUNT" ]; then
  bad send account "MSMTP_ACCOUNT unset"
elif [ "$have_msmtp" = 1 ] && [ -r "$SE_MSMTP_CONFIG" ]; then
  from=$(se_msmtp_field from); user=$(se_msmtp_field user)
  if [ -z "$from" ] || [ "$from" = "(not set)" ]; then
    bad send account "'$SE_MSMTP_ACCOUNT' not found in the msmtprc, or it has no from"
  else
    row account "$SE_MSMTP_ACCOUNT (from $from)"
    lc_from=$(printf '%s' "$from" | tr '[:upper:]' '[:lower:]')
    lc_user=$(printf '%s' "$user" | tr '[:upper:]' '[:lower:]')
    if [ -n "$user" ] && [ "$user" != "(not set)" ] && [ "$lc_user" != "$lc_from" ]; then
      warn send-as "from differs from the login user: a send-as alias, so a Sender: header will name the login"
    fi
  fi
else
  row account "$SE_MSMTP_ACCOUNT"
fi
# Optional keys: report presence (paths and host only, never a value that could be secret).
opt() { if [ -n "$2" ]; then row "$1" "$3"; else row "$1" "$4"; fi; }
opt probe "$SE_PROBE_RECIPIENT" "set" "PROBE_RECIPIENT unset (header-check needs it)"
opt wireproxy-conf "$SE_WIREPROXY_CONFIG" "$SE_WIREPROXY_CONFIG" "unset (the proxy must already be running)"
opt allowlist "$SE_ALLOWLIST_FILE" "$SE_ALLOWLIST_FILE" "none (every send still asks)"
# Reading (inbox.sh): configured when a user and a password command resolve, from the
# IMAP_* keys or the msmtp account. No live IMAP call here; inbox.sh folders is that test.
imap_user="$SE_IMAP_USER"; imap_pw="$SE_IMAP_PASSWORDCOMMAND"
if [ "$have_msmtp" = 1 ] || [ -r "${SE_MSMTP_CONFIG:-/nonexistent}" ]; then
  [ -n "$imap_user" ] || imap_user=$(se_msmtp_field user)
  [ -n "$imap_pw" ] || imap_pw=$(se_msmtp_field passwordeval)
fi
if [ -n "$imap_user" ] && [ "$imap_user" != "(not set)" ] && [ -n "$imap_pw" ]; then
  row imap "reading configured: ${SE_IMAP_SERVER:-imap.gmail.com} via socks5h://$SE_SOCKS_HOST:$SE_SOCKS_PORT (user and password command set)"
else
  read_ok=0
  row imap "reading not configured [read] (needs IMAP_USER / IMAP_PASSWORDCOMMAND or an msmtp user / passwordeval)"
fi
opt probe-imap "$SE_PROBE_IMAP_PASSWORDCOMMAND" "probe read-back configured: ${SE_PROBE_IMAP_SERVER:-(PROBE_IMAP_SERVER unset)}" "unset (header-check prints a checklist instead)"
has_srv=0; has_pw=0
[ -n "$SE_PROBE_IMAP_SERVER" ] && has_srv=1
[ -n "$SE_PROBE_IMAP_PASSWORDCOMMAND" ] && has_pw=1
if [ "$has_srv" != "$has_pw" ]; then
  warn probe-imap "only one of PROBE_IMAP_SERVER / PROBE_IMAP_PASSWORDCOMMAND is set: header-check needs both to read the probe back, so it will print the checklist"
fi
if [ -n "$SE_LEGACY_IMAP_KEYS" ]; then
  warn imap-keys "$SE_LEGACY_IMAP_KEYS are 1.0.x keys, ignored since 1.1.0 (IMAP_USER too, when it sits next to them): rename to PROBE_IMAP_SERVER / PROBE_IMAP_USER / PROBE_IMAP_PASSWORDCOMMAND / PROBE_IMAP_MAILBOX (see the skill's migration table)"
fi

# egress-check first: it may start wireproxy, so the SOCKS row after it is the real state.
echo "── egress-check"
if out=$(se_egress_main 2>&1); then
  row verdict "ok"
else
  bad both verdict "REFUSED"
fi
printf '%s\n' "$out" | sed 's/^/   /'

echo "── proxy"
if se_port_open "$SE_SOCKS_HOST" "$SE_SOCKS_PORT"; then
  row socks "$SE_SOCKS_HOST:$SE_SOCKS_PORT listening"
else
  bad both socks "$SE_SOCKS_HOST:$SE_SOCKS_PORT not listening"
fi

echo "── header-check"
if [ "$have_msmtp" = 1 ] && [ -n "$SE_MSMTP_ACCOUNT" ] && [ -r "${SE_MSMTP_CONFIG:-/nonexistent}" ]; then
  marker=$(se_probe_marker)
  if [ -s "$marker" ]; then row probe-pass "recorded ($marker)"
  else row probe-pass "none for this account + SOCKS endpoint: run header-check.sh before the first send"; fi
fi

echo "── temp configs"
stale=$(find "$SE_STATE_DIR" -maxdepth 1 -name 'himalaya-*.toml' -mmin +60 2>/dev/null | grep -c '')
if [ "$stale" -gt 0 ]; then
  find "$SE_STATE_DIR" -maxdepth 1 -name 'himalaya-*.toml' -mmin +60 -exec rm -f -- {} + 2>/dev/null
  row stale "removed $stale himalaya temp config(s) older than 1 h (a killed run)"
else
  row stale "none"
fi

echo "── summary"
row send-ready "$([ "$send_ok" = 1 ] && echo yes || echo NO)"
row read-ready "$([ "$read_ok" = 1 ] && echo yes || echo NO)"
if [ "$mode" = read ]; then [ "$read_ok" = 1 ]; else [ "$send_ok" = 1 ]; fi
exit $?
