#!/usr/bin/env bash
# ok/bad always return 0, so A && ok || bad is if/else; "~/" is a case label, not a path.
# shellcheck disable=SC2015,SC2088
# Case suite for egress-check.sh: the pure range logic (se_judge) fed fixed IPs, the
# config parser, and the whole check end to end against a stub curl and a local listener.
# No network, no proxy, no credentials.
#
# Addresses are documentation ranges only: 198.51.100.0/24 and 203.0.113.0/24 (RFC 5737)
# and 2001:db8::/32 (RFC 3849). Two IPv4 ranges are needed because "a different /24 is
# ok" cannot be shown inside a single /24.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../scripts/egress-check.sh
. "$ROOT/scripts/egress-check.sh"
pass=0; fail=0
TMP=$(mktemp -d)
LPID=""
cleanup() { [ -n "$LPID" ] && kill "$LPID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s — %s\n' "$1" "$2"; fail=$((fail+1)); }

judge() { # name want(ok|refuse) d4 d6 proxied
  local out rc
  out=$(se_judge "$3" "$4" "$5" 2>/dev/null); rc=$?
  local got=ok; [ "$rc" = 0 ] || got=refuse
  local okfield
  okfield=$(printf '%s' "$out" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["ok"])' 2>/dev/null)
  local want_field=False; [ "$2" = ok ] && want_field=True
  if [ "$got" = "$2" ] && [ "$okfield" = "$want_field" ]; then
    ok "$(printf '%-52s %s' "$1" "$got")"
  else
    bad "$1" "want=$2 got=$got json=$out"
  fi
}

echo "se_judge must REFUSE"
judge "proxied unmeasured"                     refuse 198.51.100.7 ""           ""
judge "proxied not an IP"                      refuse 198.51.100.7 ""           "nope"
judge "proxied == direct v4"                   refuse 198.51.100.7 ""           198.51.100.7
judge "proxied == direct v6"                   refuse 198.51.100.7 2001:db8:1::1 2001:db8:1::1
judge "proxied in the direct v4 /24"           refuse 198.51.100.7 ""           198.51.100.200
judge "/24 edges: .0 vs .255"                  refuse 198.51.100.0 ""           198.51.100.255
judge "proxied in the direct v6 /48"           refuse 198.51.100.7 2001:db8:1::1 2001:db8:1:ffff::2
judge "no direct IP at all"                    refuse ""           ""           203.0.113.9

echo "se_judge must ALLOW"
judge "v4 in a different /24"                  ok 198.51.100.7 ""            203.0.113.9
judge "v6 in a different /48"                  ok 198.51.100.7 2001:db8:1::1 2001:db8:2::1
judge "v4 proxied, direct v6 present"          ok 198.51.100.7 2001:db8:1::1 203.0.113.9
judge "v6 proxied, direct v6 missing"          ok 198.51.100.7 ""            2001:db8:2::1
judge "v4 proxied, only direct v6"             ok ""           2001:db8:1::1 203.0.113.9

echo "JSON line"
out=$(se_judge 198.51.100.7 2001:db8:1::1 203.0.113.9 2>/dev/null)
keys=$(printf '%s' "$out" | python3 -I -c 'import json,sys; print(",".join(sorted(json.load(sys.stdin))))')
[ "$keys" = "direct_v4,direct_v6,ok,proxied" ] && ok "keys are direct_v4,direct_v6,proxied,ok" || bad "keys" "$keys"
[ "$(printf '%s\n' "$out" | grep -c '')" = 1 ] && ok "exactly one line" || bad "one line" "$out"
err=$(se_judge 198.51.100.7 "" 198.51.100.8 2>&1 >/dev/null)
case "$err" in "egress-check: REFUSED — "*) ok "refusal reason is one line on stderr" ;; *) bad "reason" "$err" ;; esac

echo "config parser (parsed, never sourced)"
CFG="$TMP/config"
cat >"$CFG" <<EOF
# comment
MSMTP_CONFIG=~/mail/msmtprc
MSMTP_ACCOUNT="work"
PROBE_RECIPIENT='probe@example.net'
SOCKS_PORT = 1080
EVIL=\$(touch $TMP/pwned)
ALLOWLIST_FILE=\$(touch $TMP/pwned2)
EOF
SMTP_EGRESS_CONFIG="$CFG" se_load_config
[ "$SE_MSMTP_CONFIG" = "$HOME/mail/msmtprc" ] && ok "~/ expands to \$HOME" || bad "tilde" "$SE_MSMTP_CONFIG"
[ "$SE_MSMTP_ACCOUNT" = work ] && ok "double quotes stripped" || bad "dquote" "$SE_MSMTP_ACCOUNT"
[ "$SE_PROBE_RECIPIENT" = probe@example.net ] && ok "single quotes stripped" || bad "squote" "$SE_PROBE_RECIPIENT"
[ "$SE_SOCKS_PORT" = 1080 ] && ok "spaces around = tolerated" || bad "spaces" "$SE_SOCKS_PORT"
[ "$SE_SOCKS_HOST" = 127.0.0.1 ] && ok "SOCKS_HOST defaults to 127.0.0.1" || bad "default host" "$SE_SOCKS_HOST"
[ ! -e "$TMP/pwned" ] && [ ! -e "$TMP/pwned2" ] && ok "a \$(…) value never executes" || bad "exec" "config ran a command"
SMTP_EGRESS_CONFIG="$TMP/absent" se_load_config
[ "$SE_SOCKS_PORT" = 25344 ] && ok "SOCKS_PORT defaults to 25344" || bad "default port" "$SE_SOCKS_PORT"

echo "end to end (stub curl, local listener)"
# A port that is closed: bind, read the number, close.
CLOSED=$(python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
printf 'SOCKS_PORT=%s\n' "$CLOSED" >"$TMP/c-closed"
out=$(SMTP_EGRESS_CONFIG="$TMP/c-closed" bash "$ROOT/scripts/egress-check.sh" 2>"$TMP/err"); rc=$?
[ "$rc" = 1 ] && grep -q 'not listening' "$TMP/err" && printf '%s' "$out" | grep -q '"ok": false' \
  && ok "closed port, no WIREPROXY_CONFIG → refuse before any network call" || bad "closed port" "rc=$rc out=$out err=$(cat "$TMP/err")"

python3 -I -c '
import socket, sys
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(16)
open(sys.argv[1], "w").write(str(s.getsockname()[1]))
while True:
    c, _ = s.accept(); c.close()' "$TMP/port" &
LPID=$!
for _ in $(seq 1 50); do [ -s "$TMP/port" ] && break; sleep 0.1; done
PORT=$(cat "$TMP/port")
printf 'SOCKS_PORT=%s\n' "$PORT" >"$TMP/c-open"
mkdir -p "$TMP/bin"
cat >"$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in --socks5-hostname) echo "ip=$STUB_PROXIED"; exit 0 ;; esac; done
for a in "$@"; do case "$a" in -6) [ -n "$STUB_V6" ] || exit 7; echo "ip=$STUB_V6"; exit 0 ;; -4) echo "ip=$STUB_V4"; exit 0 ;; esac; done
exit 7
EOF
chmod +x "$TMP/bin/curl"
e2e() { # name want-rc v4 v6 proxied
  local out rc
  out=$(PATH="$TMP/bin:$PATH" STUB_V4="$3" STUB_V6="$4" STUB_PROXIED="$5" SMTP_EGRESS_CONFIG="$TMP/c-open" \
    bash "$ROOT/scripts/egress-check.sh" 2>/dev/null); rc=$?
  [ "$rc" = "$2" ] && ok "$(printf '%-52s rc=%s %s' "$1" "$rc" "$out")" || bad "$1" "rc=$rc out=$out"
}
e2e "proxy is a different exit → ok"           0 198.51.100.7 2001:db8:1::1 203.0.113.9
e2e "proxy leaks the same v4 → refuse"         1 198.51.100.7 ""            198.51.100.7
e2e "no v6 on this machine is fine"            0 198.51.100.7 ""            203.0.113.9
e2e "proxy unreachable (empty ip=) → refuse"   1 198.51.100.7 ""            ""

echo
echo "passed ${pass}, failed ${fail}"
[ "$fail" -eq 0 ]
