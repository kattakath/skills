#!/usr/bin/env bash
# doctor.sh — one-shot preflight for smtp-egress. Reads and measures; changes nothing
# except that egress-check may start wireproxy when WIREPROXY_CONFIG is set.
#
# Reports: msmtp / wireproxy on PATH (+ versions), the config file and its mode (must be
# 600), the msmtprc and the account's from (WARN when it is a send-as alias of the login
# user), the egress-check verdict, then the SOCKS port (after egress-check, which may
# have just started wireproxy), and whether a header-check PASS is recorded for this
# exact account + SOCKS endpoint.
#
# Exit: 0 when every row is ok (WARN rows do not fail), 1 when any row FAILS.
# Never prints a secret: paths, host, port and the account's from only. from/user are
# read from the msmtprc file; passwordeval is never run.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=egress-check.sh
. "$HERE/egress-check.sh"

status=0
row() { printf '   %-14s: %s\n' "$1" "$2"; }
bad() { row "$1" "FAIL — $2"; status=1; }
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
  bad msmtp "not on PATH (nix shell nixpkgs#msmtp)"
fi
if command -v wireproxy >/dev/null 2>&1; then
  row wireproxy "$(wireproxy --version 2>/dev/null | head -1)"
else
  row wireproxy "not on PATH (optional: any SOCKS5 proxy works)"
fi
for t in curl python3 node; do
  if command -v "$t" >/dev/null 2>&1; then row "$t" "yes"; else bad "$t" "not on PATH"; fi
done

echo "── config"
se_load_config
if [ -r "$SE_CONFIG_FILE" ]; then
  m=$(mode_of "$SE_CONFIG_FILE")
  if [ "$m" = 600 ]; then row config "$SE_CONFIG_FILE (mode 600)"
  else bad config "$SE_CONFIG_FILE has mode ${m:-?}; chmod 600 it"; fi
else
  bad config "missing: $SE_CONFIG_FILE (see the skill's config section)"
fi
if [ -n "$SE_MSMTP_CONFIG" ] && [ -r "$SE_MSMTP_CONFIG" ]; then
  row msmtprc "$SE_MSMTP_CONFIG (mode $(mode_of "$SE_MSMTP_CONFIG"))"
else
  bad msmtprc "MSMTP_CONFIG unset or unreadable"
fi
if [ -z "$SE_MSMTP_ACCOUNT" ]; then
  bad account "MSMTP_ACCOUNT unset"
elif [ "$have_msmtp" = 1 ] && [ -r "$SE_MSMTP_CONFIG" ]; then
  from=$(se_msmtp_field from); user=$(se_msmtp_field user)
  if [ -z "$from" ] || [ "$from" = "(not set)" ]; then
    bad account "'$SE_MSMTP_ACCOUNT' not found in the msmtprc, or it has no from"
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
opt imap "$SE_IMAP_HOST" "$SE_IMAP_HOST" "unset (header-check prints a checklist instead)"

# egress-check first: it may start wireproxy, so the SOCKS row after it is the real state.
echo "── egress-check"
if out=$(se_egress_main 2>&1); then
  row verdict "ok"
else
  bad verdict "REFUSED"
fi
printf '%s\n' "$out" | sed 's/^/   /'

echo "── proxy"
if se_port_open "$SE_SOCKS_HOST" "$SE_SOCKS_PORT"; then
  row socks "$SE_SOCKS_HOST:$SE_SOCKS_PORT listening"
else
  bad socks "$SE_SOCKS_HOST:$SE_SOCKS_PORT not listening"
fi

echo "── header-check"
if [ "$have_msmtp" = 1 ] && [ -n "$SE_MSMTP_ACCOUNT" ] && [ -r "${SE_MSMTP_CONFIG:-/nonexistent}" ]; then
  marker=$(se_probe_marker)
  if [ -s "$marker" ]; then row probe-pass "recorded ($marker)"
  else row probe-pass "none for this account + SOCKS endpoint: run header-check.sh before the first send"; fi
fi

exit $status
