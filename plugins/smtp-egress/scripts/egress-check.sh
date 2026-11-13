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
  SE_IMAP_SERVER="" SE_IMAP_USER="" SE_IMAP_PASSWORDCOMMAND=""
  SE_PROBE_IMAP_SERVER="" SE_PROBE_IMAP_USER="" SE_PROBE_IMAP_PASSWORDCOMMAND="" SE_PROBE_IMAP_MAILBOX=""
  SE_LEGACY_IMAP_KEYS=""
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
          PROBE_RECIPIENT | ALLOWLIST_FILE | IMAP_SERVER | IMAP_USER | IMAP_PASSWORDCOMMAND | \
          PROBE_IMAP_SERVER | PROBE_IMAP_USER | PROBE_IMAP_PASSWORDCOMMAND | PROBE_IMAP_MAILBOX)
          printf -v "SE_$key" '%s' "$val" ;;
        # 1.0.x keys for header-check's read-back, renamed PROBE_IMAP_* in 1.1.0.
        IMAP_HOST | IMAP_PORT | IMAP_PASSWORDEVAL | IMAP_MAILBOX)
          SE_LEGACY_IMAP_KEYS="${SE_LEGACY_IMAP_KEYS:+$SE_LEGACY_IMAP_KEYS }$key" ;;
      esac
    done <"$SE_CONFIG_FILE"
  fi
  # IMAP_USER meant the PROBE mailbox's user in 1.0.x and the READING user since 1.1.0.
  # Next to another 1.0.x key, and with no PROBE_IMAP_USER, it is the old meaning: ignore it.
  if [ -n "$SE_LEGACY_IMAP_KEYS" ] && [ -n "$SE_IMAP_USER" ] && [ -z "$SE_PROBE_IMAP_USER" ]; then
    SE_LEGACY_IMAP_KEYS="$SE_LEGACY_IMAP_KEYS IMAP_USER"
    SE_IMAP_USER=""
  fi
  SE_SOCKS_HOST="${SE_SOCKS_HOST:-127.0.0.1}"
  SE_SOCKS_PORT="${SE_SOCKS_PORT:-25344}"
}

# One setting (e.g. from, user) of the configured msmtp account, read from the msmtprc
# itself. NOT `msmtp --pretend`: that evaluates passwordeval first, so without the
# password env it exits 78 and prints nothing (measured with msmtp 1.8.32). Follows
# msmtp's file rules: `#` comments, `defaults` (settings apply to accounts defined after
# them), `account NAME [: PARENT[, PARENT…]]`, `account default : NAME`, quoted values.
# Prints nothing when the account or the setting is missing. Never runs a command.
se_msmtp_field() {
  python3 -I - "$SE_MSMTP_CONFIG" "$SE_MSMTP_ACCOUNT" "$1" <<'PY'
import shlex, sys
path, want, key = sys.argv[1:4]
defaults, accounts, cur = {}, {}, None
try:
    lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
except OSError:
    sys.exit(0)
for line in lines:
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    parts = line.split(None, 1)
    cmd, arg = parts[0], (parts[1].strip() if len(parts) > 1 else "")
    if cmd == "defaults":
        cur = defaults
        continue
    if cmd == "account":
        name, _, parents = arg.partition(":")
        name = name.strip()
        acct = dict(defaults)
        for par in filter(None, (x.strip() for x in parents.split(","))):
            acct.update(accounts.get(par, {}))
        accounts[name] = cur = acct
        continue
    if cur is None:
        continue
    try:
        val = " ".join(shlex.split(arg)) if arg else ""
    except ValueError:
        val = arg
    cur[cmd] = val
acct = accounts.get(want)
if acct and key in acct:
    print(acct[key])
PY
}

# The key a passing header-check is recorded under: the msmtp account, its from and the
# SOCKS endpoint. Change any of them and the old pass no longer counts.
se_probe_key() {
  printf '%s|%s|%s|%s:%s' "$SE_MSMTP_CONFIG" "$SE_MSMTP_ACCOUNT" "$(se_msmtp_field from)" "$SE_SOCKS_HOST" "$SE_SOCKS_PORT" \
    | python3 -I -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest()[:16])'
}
se_probe_marker() { printf '%s/probe-%s.pass' "$SE_STATE_DIR" "$(se_probe_key)"; }

# The temp-config protocol, so a config is never left behind and never orphaned by a
# signal between "created" and "trap set":
#   SE_TMP_CFG=""; trap 'rm -f -- "$SE_TMP_CFG"' EXIT   (single quotes: expanded at exit,
#   so a path with quotes or spaces is safe); se_himalaya_path; se_himalaya_config …
# se_himalaya_path only PICKS the path (in this shell, no subshell); the file appears in
# se_himalaya_config, after the trap exists. himalaya splits -c on ':' like $PATH, so a
# state dir containing ':' is refused.
se_himalaya_path() {
  mkdir -p "$SE_STATE_DIR" && chmod 700 "$SE_STATE_DIR" 2>/dev/null
  SE_TMP_CFG="$SE_STATE_DIR/himalaya-$$-$RANDOM$RANDOM.toml"
  case "$SE_TMP_CFG" in *:*)
    echo "smtp-egress: the state dir contains ':', which himalaya -c would split into two paths; set XDG_STATE_HOME to a path without ':'" >&2
    SE_TMP_CFG=""; return 2 ;;
  esac
}

# Writes a himalaya 2.x TOML for ONE read-only IMAP account to the NEW file $1 (mode 600,
# O_EXCL, so an existing file or symlink there is refused). Args:
#   path server user password-command email
# The proxy is ALWAYS set (socks5h://, so DNS resolves at the proxy too) from
# SOCKS_HOST/SOCKS_PORT; without a valid endpoint this refuses. No SMTP backend is
# written, so `message send` through this file cannot work. Values are written as TOML
# basic strings (JSON escapes); the password command is stored, never run, here.
# A cleartext imap:// server is refused unless SMTP_EGRESS_TEST_CLEARTEXT_IMAP=1 (the
# loopback wire test).
se_himalaya_config() {
  case "$SE_SOCKS_PORT" in '' | *[!0-9]*) echo "smtp-egress: no valid SOCKS_PORT, refusing to write an unproxied IMAP config" >&2; return 2 ;; esac
  [ -n "$SE_SOCKS_HOST" ] || { echo "smtp-egress: no SOCKS_HOST, refusing to write an unproxied IMAP config" >&2; return 2; }
  [ -n "$1" ] && [ -n "$2" ] && [ -n "$3" ] && [ -n "$4" ] || { echo "smtp-egress: config path, IMAP server, user and password command are all required" >&2; return 2; }
  python3 -I - "$1" "$SE_SOCKS_HOST" "$SE_SOCKS_PORT" "$2" "$3" "$4" "${5:-$3}" "${SMTP_EGRESS_TEST_CLEARTEXT_IMAP:-}" <<'PY'
import json, os, sys
path, shost, sport, server, user, pwcmd, email, cleartext = sys.argv[1:9]
if server.lower().startswith("imap://") and cleartext != "1":
    print("smtp-egress: refusing a cleartext imap:// server; use a bare host (implicit TLS on 993) or imaps://host:port", file=sys.stderr)
    sys.exit(2)
host = f"[{shost}]" if ":" in shost else shost
q = json.dumps
lines = [
    "[accounts.smtp-egress]",
    "default = true",
    f"email = {q(email)}",
    f"proxy.url = {q(f'socks5h://{host}:{sport}')}",
    f"imap.server = {q(server)}",
]
if server.lower().startswith("imap://"):
    lines.append("imap.starttls = false")
lines += [f"imap.sasl.plain.username = {q(user)}", f"imap.sasl.plain.password.command = {q(pwcmd)}"]
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
with os.fdopen(fd, "w") as f:
    f.write("\n".join(lines) + "\n")
PY
}

# Arms the temp-config cleanup for this shell: EXIT removes it; INT/TERM/HUP exit
# (which runs EXIT). Call BEFORE se_himalaya_path.
se_arm_cfg_trap() {
  SE_TMP_CFG=""
  trap 'rm -f -- "$SE_TMP_CFG"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
}

# Strips terminal control sequences and C0/C1 controls (keeping tab and newline) from
# mail content, which is untrusted: a Subject or body must not drive the terminal.
se_sanitize() {
  python3 -I -c '
import re, sys
t = sys.stdin.buffer.read().decode("utf-8", "replace")
t = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)?|\x1b.", "", t)
t = re.sub(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]", "", t.replace("\r\n", "\n"))
sys.stdout.write(t)'
}

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
