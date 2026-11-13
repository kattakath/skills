#!/usr/bin/env bash
# egress-check — is the SOCKS5 proxy really a different network exit than this machine?
#
#   1. The SOCKS port must be listening. If it is not and WIREPROXY_CONFIG is set,
#      start wireproxy detached (log in $XDG_STATE_HOME/smtp-egress/) and wait up to 10 s.
#   2. Measure the DIRECT egress, v4 and v6 separately (a missing v6 is fine).
#   3. Measure the PROXIED egress through the SOCKS port (remote DNS: --socks5-hostname).
#   4. Refuse when the proxied IP is unmeasured, equals a direct IP, or shares the direct
#      IPv4 /24 or IPv6 /48.
#   5. Print ONE JSON line: {"direct_v4", "direct_v6", "proxied", "ok"}. IPs only — the
#      comparison IS the check, so there is no ISP/ASN/provider list to maintain.
#
# Exit 0 = ok, 1 = refused (one-line reason on stderr), 2 = config error.
#
# It measures CURL's path through the proxy. Only header-check, on a delivered message,
# proves the path msmtp took.
#
# Sourceable: send.sh, header-check.sh, doctor.sh and the tests source this file for
# se_load_config / se_judge / se_port_open; main runs only when executed directly.
set -uo pipefail

SE_TRACE_URL="${SMTP_EGRESS_TRACE_URL:-https://www.cloudflare.com/cdn-cgi/trace}"
SE_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/smtp-egress"

# KEY=VALUE config, parsed — never sourced, so a `$(…)` in a value is inert text.
# Known keys become SE_<KEY>; anything else is ignored. A leading ~/ expands to $HOME.
# The SE_* values are read by the scripts that source this file.
# shellcheck disable=SC2034
se_load_config() {
  SE_CONFIG_FILE="${SMTP_EGRESS_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/smtp-egress/config}"
  SE_MSMTP_CONFIG="" SE_MSMTP_ACCOUNT="" SE_SOCKS_HOST="" SE_SOCKS_PORT=""
  SE_WIREPROXY_CONFIG="" SE_PROBE_RECIPIENT="" SE_ALLOWLIST_FILE=""
  SE_IMAP_HOST="" SE_IMAP_PORT="" SE_IMAP_USER="" SE_IMAP_PASSWORDEVAL="" SE_IMAP_MAILBOX=""
  if [ -r "$SE_CONFIG_FILE" ]; then
    local line key val
    while IFS= read -r line || [ -n "$line" ]; do
      line="${line%$'\r'}"
      case "$line" in '' | '#'*) continue ;; *=*) ;; *) continue ;; esac
      key="${line%%=*}"; key="${key//[[:space:]]/}"
      val="${line#*=}"
      val="${val#"${val%%[![:space:]]*}"}"; val="${val%"${val##*[![:space:]]}"}"
      case "$val" in \"*\") val="${val:1:${#val}-2}" ;; \'*\') val="${val:1:${#val}-2}" ;; esac
      # shellcheck disable=SC2088  # matching a literal ~/ in the file, not expanding one
      case "$val" in '~/'*) val="$HOME/${val:2}" ;; esac
      case "$key" in
        MSMTP_CONFIG | MSMTP_ACCOUNT | SOCKS_HOST | SOCKS_PORT | WIREPROXY_CONFIG | \
          PROBE_RECIPIENT | ALLOWLIST_FILE | IMAP_HOST | IMAP_PORT | IMAP_USER | \
          IMAP_PASSWORDEVAL | IMAP_MAILBOX)
          printf -v "SE_$key" '%s' "$val" ;;
      esac
    done <"$SE_CONFIG_FILE"
  fi
  SE_SOCKS_HOST="${SE_SOCKS_HOST:-127.0.0.1}"
  SE_SOCKS_PORT="${SE_SOCKS_PORT:-25344}"
}

# One field of msmtp's --pretend block for the configured account (e.g. from, user).
# Only the named field is ever printed: the block also names the passwordeval command.
se_msmtp_field() {
  msmtp -C "$SE_MSMTP_CONFIG" -a "$SE_MSMTP_ACCOUNT" --pretend </dev/null 2>/dev/null \
    | sed -n "s/^$1 = //p" | head -1
}

# The key a passing header-check is recorded under: the msmtp account, its from and the
# SOCKS endpoint. Change any of them and the old pass no longer counts.
se_probe_key() {
  printf '%s|%s|%s|%s:%s' "$SE_MSMTP_CONFIG" "$SE_MSMTP_ACCOUNT" "$(se_msmtp_field from)" "$SE_SOCKS_HOST" "$SE_SOCKS_PORT" \
    | python3 -I -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest()[:16])'
}
se_probe_marker() { printf '%s/probe-%s.pass' "$SE_STATE_DIR" "$(se_probe_key)"; }

# Is host:port accepting TCP connections? (python, so no nc/bash-/dev/tcp variance)
se_port_open() {
  python3 -I -c '
import socket, sys
try:
    socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=1).close()
except Exception:
    sys.exit(1)' "$1" "$2"
}

# The pure decision. Args: DIRECT_V4 DIRECT_V6 PROXIED (empty = unmeasured).
# Prints the JSON line on stdout; on refusal prints the reason on stderr and returns 1.
se_judge() {
  python3 -I - "$@" <<'PY'
import ipaddress, json, sys

d4, d6, px = (sys.argv[1:4] + ["", "", ""])[:3]

def ip(s):
    try:
        return ipaddress.ip_address(s.strip()) if s.strip() else None
    except ValueError:
        return None

D4, D6, P = ip(d4), ip(d6), ip(px)
reason = None
if P is None:
    reason = "proxied egress was not measured" if not px.strip() else f"proxied egress is not an IP: {px!r}"
elif D4 is None and D6 is None:
    reason = "direct egress was not measured, so there is nothing to compare against"
elif P in (D4, D6):
    reason = f"proxied egress {P} EQUALS the direct egress: the proxy is not a different exit"
elif P.version == 4 and D4 is not None and P in ipaddress.ip_network(f"{D4}/24", strict=False):
    reason = f"proxied egress {P} shares the direct IPv4 /24 ({ipaddress.ip_network(f'{D4}/24', strict=False)})"
elif P.version == 6 and D6 is not None and P in ipaddress.ip_network(f"{D6}/48", strict=False):
    reason = f"proxied egress {P} shares the direct IPv6 /48 ({ipaddress.ip_network(f'{D6}/48', strict=False)})"

print(json.dumps({
    "direct_v4": str(D4) if D4 else None,
    "direct_v6": str(D6) if D6 else None,
    "proxied": str(P) if P else None,
    "ok": reason is None,
}))
if reason:
    print(f"egress-check: REFUSED — {reason}", file=sys.stderr)
    sys.exit(1)
PY
}

# `ip=` from the trace endpoint. Extra curl args select the family or the proxy.
se_trace_ip() {
  curl -fsS --max-time 10 "$@" "$SE_TRACE_URL" 2>/dev/null | sed -n 's/^ip=//p' | head -1
}

# Start wireproxy detached when the port is closed and a config is named.
se_ensure_proxy() {
  se_port_open "$SE_SOCKS_HOST" "$SE_SOCKS_PORT" && return 0
  if [ -z "$SE_WIREPROXY_CONFIG" ]; then
    echo "egress-check: REFUSED — SOCKS port $SE_SOCKS_HOST:$SE_SOCKS_PORT is not listening and WIREPROXY_CONFIG is unset" >&2
    return 1
  fi
  if ! command -v wireproxy >/dev/null 2>&1; then
    echo "egress-check: REFUSED — SOCKS port closed and wireproxy is not on PATH" >&2
    return 1
  fi
  if ! wireproxy -n -c "$SE_WIREPROXY_CONFIG" >/dev/null 2>&1; then
    echo "egress-check: REFUSED — wireproxy rejects WIREPROXY_CONFIG (wireproxy -n -c)" >&2
    return 1
  fi
  mkdir -p "$SE_STATE_DIR"
  nohup wireproxy -c "$SE_WIREPROXY_CONFIG" >>"$SE_STATE_DIR/wireproxy.log" 2>&1 </dev/null &
  disown 2>/dev/null || true
  for _ in $(seq 1 20); do
    se_port_open "$SE_SOCKS_HOST" "$SE_SOCKS_PORT" && return 0
    sleep 0.5
  done
  echo "egress-check: REFUSED — started wireproxy but $SE_SOCKS_HOST:$SE_SOCKS_PORT did not open within 10 s (log: $SE_STATE_DIR/wireproxy.log)" >&2
  return 1
}

se_egress_main() {
  se_load_config
  case "$SE_SOCKS_PORT" in '' | *[!0-9]*)
    echo "egress-check: bad SOCKS_PORT in $SE_CONFIG_FILE" >&2; return 2 ;;
  esac
  if ! se_ensure_proxy; then
    printf '{"direct_v4": null, "direct_v6": null, "proxied": null, "ok": false}\n'
    return 1
  fi
  local d4 d6 px
  d4=$(se_trace_ip -4)
  d6=$(se_trace_ip -6)
  px=$(se_trace_ip --socks5-hostname "$SE_SOCKS_HOST:$SE_SOCKS_PORT")
  se_judge "$d4" "$d6" "$px"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  se_egress_main "$@"
  exit $?
fi
