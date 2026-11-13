#!/usr/bin/env bash
# ok/bad always return 0, so A && ok || bad is if/else.
# shellcheck disable=SC2015
# Wire cases: the REAL himalaya, driven by the real inbox.sh, against a loopback fake
# SOCKS5 + IMAP server (fixtures/fake-imap.py). Nothing leaves 127.0.0.1: the fake SOCKS
# server answers the CONNECT itself, and curl (egress-check) is a stub.
#
# What it proves, from the IMAP commands himalaya actually sent:
#   - every connection goes through the SOCKS port, as a hostname CONNECT (socks5h);
#   - `inbox.sh read` fetches BODY.PEEK[] (never sets \Seen, RFC 3501 §6.4.5) and sends
#     no STORE — while `himalaya message read --seen` fetches BODY[], so the check can fail;
#   - list/search/folders send no mutating command at all.
# Skips (exit 0, loudly) when himalaya is not on PATH; CI runs it under
# `nix shell nixpkgs#himalaya`.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v himalaya >/dev/null 2>&1; then
  echo "SKIP: himalaya not on PATH (run under: nix shell nixpkgs#himalaya)"
  exit 0
fi
pass=0; fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s — %s\n' "$1" "$2"; fail=$((fail+1)); }

TMP=$(mktemp -d); FPID=""
cleanup() { [ -n "$FPID" ] && kill "$FPID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT
LOG="$TMP/wire.log"
python3 -I "$ROOT/tests/fixtures/fake-imap.py" "$LOG" "$TMP/ports" &
FPID=$!
for _ in $(seq 1 50); do [ -s "$TMP/ports" ] && break; sleep 0.1; done
read -r SOCKS _ <"$TMP/ports"

mkdir -p "$TMP/bin"
cat >"$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in --socks5-hostname) echo "ip=203.0.113.9"; exit 0 ;; esac; done
for a in "$@"; do case "$a" in -6) exit 7 ;; -4) echo "ip=198.51.100.7"; exit 0 ;; esac; done
exit 7
EOF
chmod +x "$TMP/bin/curl"
printf 'account test\nfrom alice@example.com\nuser alice@example.com\npasswordeval "printf fakepw"\n' >"$TMP/msmtprc"
printf 'MSMTP_CONFIG=%s\nMSMTP_ACCOUNT=test\nSOCKS_PORT=%s\nIMAP_SERVER=imap://imap.example.com:143\n' "$TMP/msmtprc" "$SOCKS" >"$TMP/config"
I() { # label args… — run inbox.sh, mark the log, keep stdout
  printf '=== %s\n' "$1" >>"$LOG"; shift
  PATH="$TMP/bin:$PATH" SMTP_EGRESS_CONFIG="$TMP/config" XDG_STATE_HOME="$TMP/state" \
    SMTP_EGRESS_TEST_CLEARTEXT_IMAP=1 bash "$ROOT/scripts/inbox.sh" "$@" 2>&1
}
section() { awk -v s="=== $1" '$0==s{on=1;next} /^=== /{on=0} on' "$LOG"; }

echo "himalaya $(himalaya --version | head -1 | cut -d' ' -f2)"
out=$(I list list -n 3); rc=$?
[ "$rc" = 0 ] && printf '%s' "$out" | grep -q $'^1\t.*Bob <bob@example.net>\thello probe$' \
  && ok "list prints id, date, from, subject" || bad "list" "rc=$rc $out"
out=$(I read read 1); rc=$?
[ "$rc" = 0 ] && printf '%s' "$out" | grep -q 'body text' && ok "read prints the message" || bad "read" "rc=$rc $out"
out=$(I search search --subject 'hello probe' --since 2026-11-02); rc=$?
[ "$rc" = 0 ] && ok "search runs" || bad "search" "rc=$rc $out"
out=$(I folders folders); rc=$?
[ "$rc" = 0 ] && printf '%s\n' "$out" | grep -qx 'Inbox' && ok "folders lists mailboxes" || bad "folders" "rc=$rc $out"

section read | grep -q 'UID FETCH 1 BODY.PEEK\[\]' && ok "read fetches BODY.PEEK[] (does not set \\Seen)" || bad "peek" "$(section read)"
section read | grep -qiE ' (UID )?STORE | BODY\[\]' && bad "no seen" "$(section read)" || ok "read sends no STORE and no BODY[]"
section search | grep -q 'UID SEARCH (SUBJECT "hello probe" SENTSINCE "02-Nov-2026")' \
  && ok "--since is inclusive (SENTSINCE that day)" || bad "since" "$(section search)"
grep -qiE 'IMAP> \S+ (UID )?(STORE|EXPUNGE|COPY|MOVE|APPEND|DELETE|CREATE|RENAME)' "$LOG" \
  && bad "read-only" "$(grep -iE 'STORE|EXPUNGE|COPY|MOVE|APPEND|DELETE' "$LOG")" || ok "no mutating IMAP command in any run"
c=$(grep -c '^SOCKS CONNECT imap.example.com:143 (atyp=3)' "$LOG"); s=$(grep -c '^=== ' "$LOG")
[ "$c" -ge "$s" ] && [ "$c" -gt 0 ] && ok "every run went through SOCKS as a hostname CONNECT ($c)" || bad "socks" "connects=$c runs=$s"
[ -z "$(find "$TMP/state" -name 'himalaya-*.toml' 2>/dev/null)" ] && ok "no generated config left behind" || bad "cleanup" "left a config"

# The control: the same read WITH --seen does fetch BODY[] — so the PEEK check can fail.
printf '=== control\n' >>"$LOG"
printf '[accounts.c]\ndefault = true\nproxy.url = "socks5h://127.0.0.1:%s"\nimap.server = "imap://imap.example.com:143"\nimap.starttls = false\nimap.sasl.plain.username = "alice@example.com"\nimap.sasl.plain.password.command = "printf fakepw"\n' "$SOCKS" >"$TMP/control.toml"
himalaya -c "$TMP/control.toml" message read --seen 1 >/dev/null 2>&1
section control | grep -q 'UID FETCH 1 BODY\[\]' && ok "control: --seen fetches BODY[] (the check is not vacuous)" || bad "control" "$(section control)"

echo
echo "passed ${pass}, failed ${fail}"
[ "$fail" -eq 0 ]
