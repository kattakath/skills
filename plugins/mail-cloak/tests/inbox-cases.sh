#!/usr/bin/env bash
# ok/bad always return 0, so A && ok || bad is if/else.
# The single-quoted lines written into stub scripts are literal code, never expanded here.
# shellcheck disable=SC2015,SC2016
# Case suite for inbox.sh against a stub himalaya (fixtures/himalaya-stub.sh) and a stub
# curl. No network: the "proxy" is a local listener that accepts and closes.
#
# Pins: the generated himalaya config ALWAYS carries the socks5h:// proxy, is mode 600
# and is removed afterwards (also on failure); each subcommand maps to the right
# himalaya argv; `read` never passes --seen; egress refusal and bad input stop before
# himalaya runs; output is plain text with control sequences stripped; the password
# command is never printed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass=0; fail=0
TMP=$(mktemp -d); LPID=""
cleanup() { [ -n "$LPID" ] && kill "$LPID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s — %s\n' "$1" "$2"; fail=$((fail+1)); }

python3 -I -c '
import socket, sys
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(16)
open(sys.argv[1], "w").write(str(s.getsockname()[1]))
while True:
    c, _ = s.accept(); c.close()' "$TMP/port" &
LPID=$!
for _ in $(seq 1 50); do [ -s "$TMP/port" ] && break; sleep 0.1; done
PORT=$(cat "$TMP/port")

mkdir -p "$TMP/bin"
cp "$ROOT/tests/fixtures/himalaya-stub.sh" "$TMP/bin/himalaya"
cat >"$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in --socks5-hostname) echo "ip=${STUB_PROXIED-203.0.113.9}"; exit 0 ;; esac; done
for a in "$@"; do case "$a" in -6) exit 7 ;; -4) echo "ip=198.51.100.7"; exit 0 ;; esac; done
exit 7
EOF
chmod +x "$TMP/bin/himalaya" "$TMP/bin/curl"
printf '# account\ndefaults\nauth on\n\naccount test\nfrom alice@example.com\nuser alice@example.com\npasswordeval "printenv SMTP_PW"\n' >"$TMP/msmtprc"
printf 'MSMTP_CONFIG=%s\nMSMTP_ACCOUNT=test\nSOCKS_PORT=%s\n' "$TMP/msmtprc" "$PORT" >"$TMP/config"

I() { # inbox.sh with the stubs; CFG overrides the config file
  rm -f "$TMP/him.argv" "$TMP/him.conf" "$TMP/him.mode"
  env -u SMTP_PW PATH="$TMP/bin:$PATH" STUB_DIR="$TMP" MAIL_CLOAK_CONFIG="${CFG:-$TMP/config}" \
    XDG_STATE_HOME="$TMP/state" bash "$ROOT/scripts/inbox.sh" "$@"
}
argv() { [ -f "$TMP/him.argv" ] && tr '\037' ' ' <"$TMP/him.argv" || true; }
leftover() { find "$TMP/state" -name 'himalaya-*.toml' 2>/dev/null | grep -c ''; }
has_argv() { # name needle
  case " $(argv) " in *"$2"*) ok "$(printf '%-50s %s' "$1" "$2")" ;; *) bad "$1" "argv: $(argv)" ;; esac
}

echo "generated config"
out=$(I list 2>&1); rc=$?
[ "$rc" = 0 ] && ok "list exits 0" || bad "list" "rc=$rc $out"
grep -qx "proxy.url = \"socks5h://127.0.0.1:$PORT\"" "$TMP/him.conf" && ok "proxy.url is socks5h://SOCKS_HOST:SOCKS_PORT" || bad "proxy" "$(cat "$TMP/him.conf")"
[ "$(cat "$TMP/him.mode")" = 600 ] && ok "config is mode 600 while himalaya runs" || bad "mode" "$(cat "$TMP/him.mode")"
grep -qx 'imap.server = "imap.gmail.com"' "$TMP/him.conf" && ok "IMAP_SERVER defaults to imap.gmail.com" || bad "server" "$(cat "$TMP/him.conf")"
grep -qx 'imap.sasl.plain.username = "alice@example.com"' "$TMP/him.conf" && ok "IMAP_USER defaults to the msmtp user" || bad "user" "$(cat "$TMP/him.conf")"
grep -qx 'imap.sasl.plain.password.command = "printenv SMTP_PW"' "$TMP/him.conf" && ok "password command defaults to msmtp passwordeval" || bad "pw" "$(cat "$TMP/him.conf")"
grep -qiE '^\s*(smtp|sendmail)\.' "$TMP/him.conf" && bad "no smtp" "an smtp backend was written" || ok "no SMTP backend in the config (cannot send)"
[ "$(leftover)" = 0 ] && ok "config removed after the run" || bad "cleanup" "$(leftover) left"
case "$out" in *printenv*) bad "secret" "password command printed" ;; *) ok "password command never printed" ;; esac
printf 'MSMTP_CONFIG=%s\nMSMTP_ACCOUNT=test\nSOCKS_PORT=%s\nIMAP_SERVER=imaps://imap.example.com:993\nIMAP_USER=reader@example.com\nIMAP_PASSWORDCOMMAND=cat /run/pw\n' "$TMP/msmtprc" "$PORT" >"$TMP/config-x"
CFG="$TMP/config-x" I folders >/dev/null 2>&1
grep -qx 'imap.server = "imaps://imap.example.com:993"' "$TMP/him.conf" && grep -qx 'imap.sasl.plain.username = "reader@example.com"' "$TMP/him.conf" \
  && grep -qx 'imap.sasl.plain.password.command = "cat /run/pw"' "$TMP/him.conf" && ok "IMAP_SERVER / IMAP_USER / IMAP_PASSWORDCOMMAND override" || bad "override" "$(cat "$TMP/him.conf" 2>/dev/null)"

echo "subcommand → himalaya argv"
out=$(I list 2>&1)
has_argv "list (default 20)" "--json envelope list --page-size 20"
case "$out" in $'12\t2026-11-12T10:00:00Z\tBob <bob@example.net>\tHello there') ok "list prints id <TAB> date <TAB> from <TAB> subject" ;; *) bad "list format" "$(printf '%q' "$out")" ;; esac
case "$out" in *$'\033'*) bad "sanitize" "escape in output" ;; *) ok "ANSI escape in a Subject is stripped" ;; esac
I list -n 5 --folder "[Gmail]/Spam" >/dev/null 2>&1
has_argv "list -n 5 --folder" "--json envelope list --page-size 5 -m [Gmail]/Spam"
I search --from bob@example.net --subject 'hello there' --since 2026-11-02 >/dev/null 2>&1
has_argv "search: from/subject/since → query" 'envelope search --page-size 20 from "bob@example.net" and subject "hello there" and after 2026-11-01 order by date desc'
I search --since 2026-03-01 >/dev/null 2>&1
has_argv "--since crosses a month (inclusive → after D-1)" "after 2026-02-28 order by date desc"
I search --subject 'say "hi" \ now' >/dev/null 2>&1
has_argv "quotes and backslashes dropped from a pattern" 'subject "say hi  now"'
out=$(I read 12 2>&1)
has_argv "read <id>" "message read 12"
case "$(argv)" in *--seen*) bad "no --seen" "$(argv)" ;; *) ok "read never passes --seen" ;; esac
case "$out" in *$'\033'* | *$'\007'*) bad "sanitize read" "control chars in output" ;; *) ok "OSC title sequence in a body is stripped" ;; esac
I read 12 --raw --folder Archive >/dev/null 2>&1
has_argv "read --raw --folder" "message read -m Archive --raw 12"
I folders >/dev/null 2>&1
has_argv "folders" "--json mailbox list"
out=$(I folders 2>&1); [ "$out" = $'INBOX\n[Gmail]/Spam' ] && ok "folders prints one name per line" || bad "folders" "$out"

echo "refusals stop before himalaya"
refuse() { # name want-rc args…
  local name="$1" want="$2"; shift 2
  local rc; I "$@" >/dev/null 2>&1; rc=$?
  if [ "$rc" = "$want" ] && [ ! -s "$TMP/him.argv" ]; then ok "$(printf '%-50s rc=%s' "$name" "$rc")"; else bad "$name" "rc=$rc argv=$(argv)"; fi
}
refuse "no subcommand"                 2
refuse "unknown subcommand"            2 delete 12
refuse "search without a filter"       2 search
refuse "read without an id"            2 read
refuse "read --seen is not an option"  2 read --seen 12
refuse "read with a shell-ish id"      2 read '12;rm'
refuse "bad --since"                   2 search --since yesterday
refuse "-n 0"                          2 list -n 0
STUB_PROXIED="" refuse "egress refused → exit 1"     1 list
STUB_PROXIED=198.51.100.7 refuse "proxy == direct → exit 1" 1 list
printf 'MSMTP_CONFIG=%s\nMSMTP_ACCOUNT=test\nSOCKS_PORT=%s\nIMAP_SERVER=imap://imap.example.com:143\n' "$TMP/msmtprc" "$PORT" >"$TMP/config-clear"
CFG="$TMP/config-clear" refuse "cleartext imap:// refused"   2 list
printf 'MSMTP_CONFIG=%s\nMSMTP_ACCOUNT=nosuch\nSOCKS_PORT=%s\n' "$TMP/msmtprc" "$PORT" >"$TMP/config-noacct"
CFG="$TMP/config-noacct" refuse "no user to default to"       2 list
[ "$(leftover)" = 0 ] && ok "no config left behind by any refusal" || bad "cleanup" "$(leftover) left"

echo "himalaya failure"
STUB_HIM_RC=3 I list >/dev/null 2>&1; rc=$?
[ "$rc" = 1 ] && ok "himalaya exit 3 → inbox.sh exit 1" || bad "him rc" "rc=$rc"
[ "$(leftover)" = 0 ] && ok "config removed after a failed run" || bad "cleanup on failure" "$(leftover) left"

echo "--help and the temp-config protocol"
I --help >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] && ok "inbox.sh --help exits 0" || bad "--help" "rc=$rc"
I list --help >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] && ok "inbox.sh list --help exits 0" || bad "list --help" "rc=$rc"
mkdir -p "$TMP/co:lon"
rm -f "$TMP/him.argv"
env -u SMTP_PW PATH="$TMP/bin:$PATH" STUB_DIR="$TMP" MAIL_CLOAK_CONFIG="$TMP/config" XDG_STATE_HOME="$TMP/co:lon" \
  bash "$ROOT/scripts/inbox.sh" list >/dev/null 2>"$TMP/colon.err"; rc=$?
[ "$rc" = 2 ] && [ ! -s "$TMP/him.argv" ] && grep -q "contains ':'" "$TMP/colon.err" && ok "a ':' in the state dir → refuse before himalaya (exit 2)" || bad "colon" "rc=$rc $(cat "$TMP/colon.err")"
QD="$TMP/it's \"quoted\" dir"; mkdir -p "$QD"
rm -f "$TMP/him.argv"
env -u SMTP_PW PATH="$TMP/bin:$PATH" STUB_DIR="$TMP" MAIL_CLOAK_CONFIG="$TMP/config" XDG_STATE_HOME="$QD" \
  bash "$ROOT/scripts/inbox.sh" folders >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] && [ -z "$(find "$QD" -name 'himalaya-*.toml')" ] && ok "a state dir with quotes and spaces: runs, and the config is removed" || bad "quoted dir" "rc=$rc left=$(find "$QD" -name 'himalaya-*.toml')"
# A run killed while himalaya is running must still remove its config (trap set first).
mkdir -p "$TMP/slowbin"; cp "$TMP/bin/curl" "$TMP/slowbin/"
printf '%s\n' '#!/usr/bin/env bash' 'cfg=""; prev=""; for a in "$@"; do [ "$prev" = "-c" ] && cfg="$a"; prev="$a"; done' \
  'printf "%s" "$cfg" >"$STUB_DIR/slow.cfg"' 'exec sleep 30' >"$TMP/slowbin/himalaya"
chmod +x "$TMP/slowbin/himalaya"
rm -f "$TMP/slow.cfg"
env -u SMTP_PW PATH="$TMP/slowbin:$PATH" STUB_DIR="$TMP" MAIL_CLOAK_CONFIG="$TMP/config" XDG_STATE_HOME="$TMP/killstate" \
  bash "$ROOT/scripts/inbox.sh" folders >/dev/null 2>&1 &
KP=$!
for _ in $(seq 1 100); do [ -s "$TMP/slow.cfg" ] && break; sleep 0.1; done
SLOWCFG=$(cat "$TMP/slow.cfg" 2>/dev/null)
[ -n "$SLOWCFG" ] && [ -f "$SLOWCFG" ] && ok "config exists while himalaya runs" || bad "slow start" "cfg=$SLOWCFG"
kill -TERM "$KP" 2>/dev/null
pkill -f "sleep 30" -P "$KP" 2>/dev/null
for _ in $(seq 1 50); do [ -e "$SLOWCFG" ] || break; sleep 0.1; done
wait "$KP" 2>/dev/null
[ -n "$SLOWCFG" ] && [ ! -e "$SLOWCFG" ] && ok "SIGTERM mid-run still removes the config" || bad "kill cleanup" "left $SLOWCFG"

echo "se_himalaya_config refuses an unproxied config"
# shellcheck source=../scripts/egress-check.sh
. "$ROOT/scripts/egress-check.sh"
SE_STATE_DIR="$TMP/state/x"; mkdir -p "$SE_STATE_DIR"
SE_SOCKS_HOST=127.0.0.1 SE_SOCKS_PORT="" se_himalaya_config "$SE_STATE_DIR/a.toml" imap.example.com u@example.com cmd >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && [ ! -e "$SE_STATE_DIR/a.toml" ] && ok "empty SOCKS_PORT → refuse, no file" || bad "no port" "rc=$rc"
SE_SOCKS_HOST="" SE_SOCKS_PORT=1080 se_himalaya_config "$SE_STATE_DIR/b.toml" imap.example.com u@example.com cmd >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && [ ! -e "$SE_STATE_DIR/b.toml" ] && ok "empty SOCKS_HOST → refuse, no file" || bad "no host" "rc=$rc"
SE_SOCKS_HOST=127.0.0.1 SE_SOCKS_PORT=1080 se_himalaya_config "$SE_STATE_DIR/c.toml" imap.example.com u@example.com 'a "q" \ b' >/dev/null 2>&1 \
  && python3 -I -c 'import sys, tomllib; d=tomllib.load(open(sys.argv[1],"rb")); a=d["accounts"]["mail-cloak"]; assert a["imap"]["sasl"]["plain"]["password"]["command"]=="a \"q\" \\ b"; assert a["proxy"]["url"]=="socks5h://127.0.0.1:1080"' "$SE_STATE_DIR/c.toml" 2>/dev/null \
  && ok "quotes/backslashes in values stay valid TOML" || bad "toml" "$(cat "$SE_STATE_DIR/c.toml" 2>/dev/null)"
[ "$(python3 -I -c 'import os,sys; print(format(os.stat(sys.argv[1]).st_mode & 0o777,"o"))' "$SE_STATE_DIR/c.toml" 2>/dev/null)" = 600 ] && ok "written mode 600" || bad "mode" "not 600"
ln -s "$TMP/elsewhere" "$SE_STATE_DIR/d.toml"
SE_SOCKS_HOST=127.0.0.1 SE_SOCKS_PORT=1080 se_himalaya_config "$SE_STATE_DIR/d.toml" imap.example.com u@example.com cmd >/dev/null 2>&1; rc=$?
[ "$rc" != 0 ] && [ ! -e "$TMP/elsewhere" ] && ok "an existing path (a symlink) is refused, never followed" || bad "symlink" "rc=$rc"
SE_SOCKS_HOST=::1 SE_SOCKS_PORT=1080 se_himalaya_config "$SE_STATE_DIR/e.toml" imap.example.com u@example.com cmd >/dev/null 2>&1
grep -qx 'proxy.url = "socks5h://\[::1\]:1080"' "$SE_STATE_DIR/e.toml" 2>/dev/null && ok "an IPv6 SOCKS_HOST is bracketed" || bad "v6 host" "$(cat "$SE_STATE_DIR/e.toml" 2>/dev/null)"
SE_STATE_DIR="$TMP/a:b"; se_himalaya_path 2>/dev/null; rc=$?
[ "$rc" = 2 ] && [ -z "$SE_TMP_CFG" ] && ok "se_himalaya_path refuses ':' and leaves no path" || bad "path colon" "rc=$rc $SE_TMP_CFG"

echo "IMAP_USER: the 1.0.x meaning next to a legacy key"
printf 'MSMTP_CONFIG=%s\nMSMTP_ACCOUNT=test\nSOCKS_PORT=%s\nIMAP_HOST=imap.example.net\nIMAP_USER=probe@example.net\n' "$TMP/msmtprc" "$PORT" >"$TMP/config-leg"
CFG="$TMP/config-leg" I folders >/dev/null 2>&1
grep -qx 'imap.sasl.plain.username = "alice@example.com"' "$TMP/him.conf" && ok "legacy IMAP_USER ignored: reading falls back to the msmtp user" || bad "legacy user" "$(grep username "$TMP/him.conf")"
printf 'MSMTP_CONFIG=%s\nMSMTP_ACCOUNT=test\nSOCKS_PORT=%s\nIMAP_USER=reader@example.com\n' "$TMP/msmtprc" "$PORT" >"$TMP/config-new"
CFG="$TMP/config-new" I folders >/dev/null 2>&1
grep -qx 'imap.sasl.plain.username = "reader@example.com"' "$TMP/him.conf" && ok "IMAP_USER alone is the 1.1.0 reading user" || bad "new user" "$(grep username "$TMP/him.conf")"
printf 'MSMTP_CONFIG=%s\nMSMTP_ACCOUNT=test\nSOCKS_PORT=%s\nIMAP_HOST=x\nIMAP_USER=reader@example.com\nPROBE_IMAP_USER=probe@example.net\n' "$TMP/msmtprc" "$PORT" >"$TMP/config-both"
CFG="$TMP/config-both" I folders >/dev/null 2>&1
grep -qx 'imap.sasl.plain.username = "reader@example.com"' "$TMP/him.conf" && ok "with PROBE_IMAP_USER set, IMAP_USER keeps its new meaning" || bad "both" "$(grep username "$TMP/him.conf")"

echo
echo "passed ${pass}, failed ${fail}"
[ "$fail" -eq 0 ]
