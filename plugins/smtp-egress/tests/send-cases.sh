#!/usr/bin/env bash
# ok/bad always return 0, so A && ok || bad is if/else; $? is read on the very next command.
# shellcheck disable=SC2015,SC2181
# Case suite for new-eml.sh, send.sh, header-check.sh and doctor.sh. No email is ever sent: msmtp and
# curl are stubs on PATH, and the SOCKS "proxy" is a local listener that accepts and
# closes. The msmtp stub records its argv and stdin so the cases can assert what a real
# send WOULD have been handed (proxy flags, --read-recipients, the bytes).
#
# Documentation ranges only (RFC 5737 / RFC 3849) and example.com / example.net.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SEND="$ROOT/scripts/send.sh"
HC="$ROOT/scripts/header-check.sh"
pass=0; fail=0
TMP=$(mktemp -d)
LPID=""
cleanup() { [ -n "$LPID" ] && kill "$LPID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s — %s\n' "$1" "$2"; fail=$((fail+1)); }

# ── fixtures ─────────────────────────────────────────────────────────────────────────
python3 -I -c '
import socket, sys
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(16)
open(sys.argv[1], "w").write(str(s.getsockname()[1]))
while True:
    c, _ = s.accept(); c.close()' "$TMP/port" &
LPID=$!
for _ in $(seq 1 50); do [ -s "$TMP/port" ] && break; sleep 0.1; done
PORT=$(cat "$TMP/port")
CLOSEDP=$(python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')

mkdir -p "$TMP/bin" "$TMP/state"
cat >"$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in --socks5-hostname) echo "ip=${STUB_PROXIED-203.0.113.9}"; exit 0 ;; esac; done
for a in "$@"; do case "$a" in -6) exit 7 ;; -4) echo "ip=198.51.100.7"; exit 0 ;; esac; done
exit 7
EOF
cat >"$TMP/bin/msmtp" <<'EOF'
#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in --version) echo "msmtp version 1.8.32 (stub)"; exit 0 ;; esac
  # Like real msmtp 1.8.32: --pretend evaluates passwordeval first and exits 78 when it fails.
  case "$a" in --pretend) [ -n "${SMTP_PW:-}" ] || { echo "msmtp: cannot read output of 'printenv SMTP_PW'" >&2; exit 78; }
    printf 'host = smtp.example.com\npasswordeval = SECRET-COMMAND\nfrom = wrong@example.org\n'; exit 0 ;; esac
done
printf '%s\n' "$@" >"$STUB_DIR/msmtp.argv"
cat >"$STUB_DIR/msmtp.stdin"
echo "host=smtp.example.com tls=on auth=on from=alice@example.com recipients=bob@example.net smtpstatus=${STUB_STATUS:-250} smtpmsg='250 OK'"
EOF
cp "$ROOT/tests/fixtures/himalaya-stub.sh" "$TMP/bin/himalaya"
chmod +x "$TMP/bin/curl" "$TMP/bin/msmtp" "$TMP/bin/himalaya"
# The shape that broke new-eml.sh in 1.0.0: a leading comment, a defaults block, then the
# account, with passwordeval reading an env var that is NOT set in this suite.
msmtprc() { # file user
  printf '# msmtp config for the example account\ndefaults\ntls on\ntls_starttls on\nauth on\n\naccount test\nhost smtp.example.com\nport 587\nfrom alice@example.com\nuser %s\npasswordeval "printenv SMTP_PW"\n' "$2" >"$1"
  chmod 600 "$1"
}
unset SMTP_PW
msmtprc "$TMP/msmtprc" alice@example.com
msmtprc "$TMP/msmtprc-alias" primary@example.org
printf 'MSMTP_CONFIG=%s\nMSMTP_ACCOUNT=test\nSOCKS_PORT=%s\n' "$TMP/msmtprc" "$PORT" >"$TMP/config"

eml() { # file [extra-header-lines…]; From alice, To bob, Subject, Date, then extras
  local f="$1"; shift
  { printf 'From: Alice <alice@example.com>\nTo: bob@example.net\nSubject: Hello there\nDate: Thu, 12 Nov 2026 10:00:00 +0000\n'
    for h in "$@"; do printf '%s\n' "$h"; done
    printf '\nThe body must never reach sent.jsonl.\n'; } >"$f"
}

S() { # run send.sh with the stubs; extra env via `env` before args is not needed
  PATH="$TMP/bin:$PATH" STUB_DIR="$TMP" SMTP_EGRESS_CONFIG="${CFG:-$TMP/config}" XDG_STATE_HOME="$TMP/state" \
    bash "$SEND" "$@"
}
LOG="$TMP/state/smtp-egress/sent.jsonl"

echo "send.sh --dry-run"
eml "$TMP/a.eml" "Message-ID: <a1@example.com>"
out=$(S --dry-run "$TMP/a.eml" 2>&1); rc=$?
[ "$rc" = 0 ] && case "$out" in *"DRY RUN ok"*) true ;; *) false ;; esac \
  && ok "passes every step with a different-exit proxy" || bad "dry-run ok" "rc=$rc $out"
[ ! -e "$TMP/msmtp.argv" ] && ok "msmtp is NOT invoked to send" || bad "dry-run msmtp" "msmtp ran"
[ ! -e "$LOG" ] && ok "nothing appended to sent.jsonl" || bad "dry-run log" "log written"
case "$out" in *SECRET-COMMAND*) bad "secret" "the --pretend block leaked" ;; *) ok "msmtp --pretend block is never printed" ;; esac

eml "$TMP/b.eml"
S --dry-run "$TMP/b.eml" >/dev/null 2>&1
head -1 "$TMP/b.eml" | grep -qE '^Message-ID: <[0-9a-f-]{36}@example\.com>$' \
  && ok "a missing Message-ID is generated and written back" || bad "msgid" "$(head -1 "$TMP/b.eml")"
cp "$TMP/b.eml" "$TMP/b.before"; S --dry-run "$TMP/b.eml" >/dev/null 2>&1
cmp -s "$TMP/b.eml" "$TMP/b.before" && ok "a second run leaves the file unchanged" || bad "idempotent" "rewrote again"

echo "send.sh must REFUSE"
refuse() { # name needle send-args…
  local name="$1" needle="$2"; shift 2
  local out rc; out=$(S "$@" 2>&1); rc=$?
  if [ "$rc" != 0 ] && case "$out" in *"$needle"*) true ;; *) false ;; esac; then ok "$(printf '%-48s %s' "$name" "$needle")"
  else bad "$name" "rc=$rc $out"; fi
}
{ printf 'From: Mallory <mallory@example.net>\nTo: bob@example.net\nSubject: x\nDate: Thu, 12 Nov 2026 10:00:00 +0000\n\nx\n'; } >"$TMP/c.eml"
refuse "From differs from the account's from" "does not match" --dry-run "$TMP/c.eml"
{ printf 'From: alice@example.com\nTo: bob@example.net\nSubject: x\n\nx\n'; } >"$TMP/d.eml"
refuse "Date missing" "missing header(s): Date" --dry-run "$TMP/d.eml"
refuse "no .eml" "cannot read" --dry-run "$TMP/none.eml"
S --dry-run "$TMP/none.eml" >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok "a config/usage error exits 2" || bad "exit 2" "rc=$rc"
S --dry-run "$TMP/c.eml" >/dev/null 2>&1; rc=$?
[ "$rc" = 1 ] && ok "a refusal exits 1" || bad "exit 1" "rc=$rc"
printf 'MSMTP_CONFIG=%s\nMSMTP_ACCOUNT=test\nSOCKS_PORT=%s\n' "$TMP/msmtprc-alias" "$PORT" >"$TMP/config-alias"; chmod 600 "$TMP/config-alias"
out=$(CFG="$TMP/config-alias" S --dry-run "$TMP/a.eml" 2>&1); rc=$?
[ "$rc" = 0 ] && case "$out" in *"WARN — the account's from"*) true ;; *) false ;; esac \
  && ok "from != login user → WARN (send-as alias), not a refusal" || bad "send-as warn" "rc=$rc $out"
STUB_PROXIED=198.51.100.7 refuse "proxy egress == direct" "EQUALS the direct" --dry-run "$TMP/a.eml"
printf 'carol@example.net\n@example.org\n' >"$TMP/allow"
printf 'MSMTP_CONFIG=%s\nMSMTP_ACCOUNT=test\nSOCKS_PORT=%s\nALLOWLIST_FILE=%s\n' "$TMP/msmtprc" "$PORT" "$TMP/allow" >"$TMP/config-allow"
CFG="$TMP/config-allow" refuse "recipient not on ALLOWLIST_FILE" "not on ALLOWLIST_FILE: bob@example.net" --dry-run "$TMP/a.eml"
printf 'bob@example.net\n' >>"$TMP/allow"
out=$(CFG="$TMP/config-allow" S --dry-run "$TMP/a.eml" 2>&1) && ok "recipient on ALLOWLIST_FILE passes" || bad "allowlist pass" "$out"
printf '@example.net\n' >"$TMP/allow"
out=$(CFG="$TMP/config-allow" S --dry-run "$TMP/a.eml" 2>&1) && ok "an @domain line covers the recipient" || bad "allowlist domain" "$out"

echo "send.sh real path (stub msmtp — nothing leaves this machine)"
eml "$TMP/a.eml" "Message-ID: <a1@example.com>" "Cc: Carol <carol@example.net>" "Bcc: dave@example.org"
out=$(S "$TMP/a.eml" 2>&1); rc=$?
[ "$rc" = 0 ] && ok "smtpstatus=250 → exit 0" || bad "send" "rc=$rc $out"
grep -qx -- "--proxy-host=127.0.0.1" "$TMP/msmtp.argv" && grep -qx -- "--proxy-port=$PORT" "$TMP/msmtp.argv" \
  && ok "proxy flags passed explicitly" || bad "proxy flags" "$(tr '\n' ' ' <"$TMP/msmtp.argv")"
grep -qx -- "--read-recipients" "$TMP/msmtp.argv" && grep -qx -- "--logfile=-" "$TMP/msmtp.argv" \
  && ok "--read-recipients and --logfile=- passed" || bad "msmtp flags" "$(tr '\n' ' ' <"$TMP/msmtp.argv")"
cmp -s "$TMP/msmtp.stdin" "$TMP/a.eml" && ok "msmtp is fed the .eml bytes unchanged" || bad "stdin" "differs"
python3 -I - "$LOG" "$TMP/a.eml" <<'PY' && ok "sent.jsonl line: ts, message_id, to/cc/bcc arrays, subject, sha256, proxied_ip, smtpstatus" || bad "log line" "$(cat "$LOG")"
import hashlib, json, sys
lines = open(sys.argv[1]).read().splitlines()
assert len(lines) == 1, lines
d = json.loads(lines[0])
assert sorted(d) == sorted(["ts", "message_id", "to", "cc", "bcc", "subject", "sha256", "proxied_ip", "smtpstatus"]), d
assert d["message_id"] == "<a1@example.com>" and d["to"] == ["bob@example.net"] and d["subject"] == "Hello there"
assert d["cc"] == ["carol@example.net"] and d["bcc"] == ["dave@example.org"], d
assert d["proxied_ip"] == "203.0.113.9" and d["smtpstatus"] == "250"
assert d["sha256"] == hashlib.sha256(open(sys.argv[2], "rb").read()).hexdigest()
PY
grep -q 'must never reach' "$LOG" && bad "no body" "the body is in sent.jsonl" || ok "no body in sent.jsonl"
rm -f "$TMP/msmtp.argv"
STUB_STATUS=550 refuse "smtpstatus 550 → refuse" "smtpstatus=250 (got 550)" "$TMP/a.eml"
[ "$(grep -c '' "$LOG")" = 1 ] && ok "a failed send appends nothing" || bad "failed log" "$(cat "$LOG")"
rm -f "$TMP/msmtp.argv"
STUB_PROXIED="" refuse "egress refused → abort before msmtp" "egress-check failed" "$TMP/a.eml"
[ ! -e "$TMP/msmtp.argv" ] && ok "msmtp never ran after an egress refusal" || bad "abort" "msmtp ran"

echo "header-check.sh --headers"
H() { bash "$HC" --headers "$1" --direct-v4 198.51.100.7 --direct-v6 2001:db8:1::1 >"$TMP/hc.out" 2>&1; }
hdr() { # file sender-hop-ip extra-lines…
  local f="$1" hop="$2"; shift 2
  { printf 'Delivered-To: probe@example.net\n'
    printf 'Received: by 2001:db8:ff::1 with SMTP id x; Thu, 12 Nov 2026 10:00:02 -0800\n'
    printf 'ARC-Authentication-Results: i=1; mx.example.net;\n       dkim=pass header.i=@example.com;\n       spf=pass;\n       dmarc=pass (p=NONE) header.from=example.com\n'
    printf 'Received: from mail.example.com (mail.example.com. [2001:db8:ff::2])\n        by mx.example.net with ESMTPS id y; Thu, 12 Nov 2026 10:00:01 -0800\n'
    for h in "$@"; do printf '%s\n' "$h"; done
    printf 'Received: from [2001:db8:ffff::5] (host.example [%s])\n        by smtp.gmail.com with ESMTPSA id z; Thu, 12 Nov 2026 10:00:00 -0800\n' "$hop"
    printf 'From: alice@example.com\nTo: probe@example.net\nSubject: probe\n'; } >"$f"
}
SIG='DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=s1; b=AAAA'
hdr "$TMP/h-pass" 203.0.113.9 "$SIG"
H "$TMP/h-pass" && grep -q 'PASS' "$TMP/hc.out" && ok "clean headers → PASS" || bad "pass" "$(cat "$TMP/hc.out")"
grep -q 'first hop IP 203.0.113.9' "$TMP/hc.out" && ok "first hop is the bottom-most Received" || bad "first hop" "$(cat "$TMP/hc.out")"
hdr "$TMP/h-leak4" 198.51.100.44 "$SIG"
H "$TMP/h-leak4"; [ $? = 1 ] && grep -q 'LEAK: 198.51.100.44' "$TMP/hc.out" && ok "first hop in direct /24 → FAIL" || bad "leak4" "$(cat "$TMP/hc.out")"
hdr "$TMP/h-leak6" 2001:db8:1:5::9 "$SIG"
H "$TMP/h-leak6"; [ $? = 1 ] && grep -q 'LEAK: 2001:db8:1:5::9' "$TMP/hc.out" && ok "first hop in direct /48 → FAIL" || bad "leak6" "$(cat "$TMP/hc.out")"
hdr "$TMP/h-sender" 203.0.113.9 "$SIG" "Sender: primary@example.org"
H "$TMP/h-sender"; [ $? = 1 ] && grep -q 'Sender: header present' "$TMP/hc.out" && ok "Sender: header → FAIL" || bad "sender" "$(cat "$TMP/hc.out")"
sed 's/dmarc=pass/dmarc=fail/' "$TMP/h-pass" >"$TMP/h-dmarc"
H "$TMP/h-dmarc"; [ $? = 1 ] && grep -q 'dmarc=pass not found' "$TMP/hc.out" && ok "dmarc=fail → FAIL" || bad "dmarc" "$(cat "$TMP/hc.out")"
sed 's/dkim=pass/dkim=neutral/' "$TMP/h-pass" >"$TMP/h-dkim"
H "$TMP/h-dkim"; [ $? = 1 ] && grep -q 'dkim=pass not found' "$TMP/hc.out" && ok "dkim not pass → FAIL" || bad "dkim" "$(cat "$TMP/hc.out")"
hdr "$TMP/h-gapps" 203.0.113.9 'DKIM-Signature: v=1; a=rsa-sha256; d=example-com.20230601.gappssmtp.com; s=x; b=AAAA'
H "$TMP/h-gapps"; [ $? = 0 ] && grep -q 'WARN  DKIM d=example-com.20230601.gappssmtp.com' "$TMP/hc.out" \
  && ok "DKIM d=*.gappssmtp.com → WARN, still PASS" || bad "gapps" "$(cat "$TMP/hc.out")"
printf 'From: alice@example.com\nTo: alice@example.com\nSubject: self\n' >"$TMP/h-self"
H "$TMP/h-self"; [ $? = 1 ] && grep -q 'self-send' "$TMP/hc.out" && ok "no Received: at all → FAIL (self-send)" || bad "self" "$(cat "$TMP/hc.out")"

echo "header-check.sh pass marker"
# shellcheck source=../scripts/header-check.sh
. "$HC"
export PATH="$TMP/bin:$PATH" STUB_DIR="$TMP" XDG_STATE_HOME="$TMP/state"
export SMTP_EGRESS_CONFIG="$TMP/config"
SE_STATE_DIR="$TMP/state/smtp-egress"; mkdir -p "$SE_STATE_DIR"
se_load_config; MARK=$(se_probe_marker)
case "$MARK" in "$SE_STATE_DIR"/probe-*.pass) ok "marker path is probe-<key>.pass" ;; *) bad "marker path" "$MARK" ;; esac
H "$TMP/h-pass"; [ ! -e "$MARK" ] && ok "a PASS on headers that are not our probe records nothing" || bad "no marker" "written"
PMID="<smtp-egress-probe-20261112T100000Z-1@example.com>"
printf 'From: alice@example.com\r\nTo: probe@example.net\r\nMessage-ID: %s\r\n\r\nx\r\n' "$PMID" >"$SE_STATE_DIR/probe-20261112T100000Z.eml"
sed "s/^Subject: probe$/Subject: probe\nMessage-ID: $PMID/" "$TMP/h-pass" >"$TMP/h-probe"
H "$TMP/h-probe"; [ -s "$MARK" ] && grep -qF "$PMID" "$MARK" && ok "a PASS on our probe's headers records the marker" || bad "marker" "$(cat "$TMP/hc.out")"
printf 'MSMTP_CONFIG=%s\nMSMTP_ACCOUNT=test\nSOCKS_PORT=1\n' "$TMP/msmtprc" >"$TMP/config-other"
[ "$(SMTP_EGRESS_CONFIG="$TMP/config-other"; se_load_config; se_probe_marker)" != "$MARK" ] \
  && ok "another SOCKS endpoint → another marker key" || bad "key" "same key"
unset SMTP_EGRESS_CONFIG

echo "header-check.sh self-probe normalisation"
same() { # want a b
  if se_same_mailbox "$2" "$3"; then got=same; else got=different; fi
  [ "$got" = "$1" ] && ok "$(printf '%-48s %s' "$2 vs $3" "$got")" || bad "$2 vs $3" "want $1 got $got"
}
same same      "alice@example.com"            "ALICE@Example.COM"
same same      "Alice <alice@example.com>"    "alice+probe@example.com"
# The Gmail rule, exercised on example domains (SMTP_EGRESS_DOTLESS_DOMAINS) so no
# real-provider address sits in this public repo.
export SMTP_EGRESS_DOTLESS_DOMAINS="example.org,example.net"
same same      "a.li.ce@example.org"          "alice+x@example.net"
same different "a.li.ce@example.com"          "alice@example.com"
unset SMTP_EGRESS_DOTLESS_DOMAINS
same different "a.lice@example.com"           "alice@example.com"
same different "alice@example.com"            "probe@example.net"

echo "header-check.sh refuses a self-probe"
printf 'MSMTP_CONFIG=%s\nMSMTP_ACCOUNT=test\nSOCKS_PORT=%s\nPROBE_RECIPIENT=Alice+probe@Example.com\n' "$TMP/msmtprc" "$PORT" >"$TMP/config-self"
out=$(PATH="$TMP/bin:$PATH" SMTP_EGRESS_CONFIG="$TMP/config-self" XDG_STATE_HOME="$TMP/state" bash "$HC" --dry-run 2>&1); rc=$?
[ "$rc" != 0 ] && case "$out" in *"sending mailbox"*) true ;; *) false ;; esac \
  && ok "PROBE_RECIPIENT == the account's from → refuse" || bad "self probe" "rc=$rc $out"
printf 'MSMTP_CONFIG=%s\nMSMTP_ACCOUNT=test\nSOCKS_PORT=%s\nPROBE_RECIPIENT=probe@example.net\n' "$TMP/msmtprc" "$PORT" >"$TMP/config-probe"
out=$(PATH="$TMP/bin:$PATH" STUB_DIR="$TMP" SMTP_EGRESS_CONFIG="$TMP/config-probe" XDG_STATE_HOME="$TMP/state" bash "$HC" --dry-run 2>&1); rc=$?
[ "$rc" = 0 ] && case "$out" in *"DRY RUN"*) true ;; *) false ;; esac && ok "--dry-run builds a probe and sends nothing" || bad "probe dry" "rc=$rc $out"

echo "header-check.sh probe read-back with himalaya (stub) through the proxy"
printf 'MSMTP_CONFIG=%s\nMSMTP_ACCOUNT=test\nSOCKS_PORT=%s\nPROBE_RECIPIENT=probe@example.net\nPROBE_IMAP_SERVER=imap.example.net\nPROBE_IMAP_PASSWORDCOMMAND=printenv PROBE_PW\n' "$TMP/msmtprc" "$PORT" >"$TMP/config-rb"
RB() { PATH="$TMP/bin:$PATH" STUB_DIR="$TMP" SMTP_EGRESS_CONFIG="$TMP/config-rb" XDG_STATE_HOME="$TMP/rbstate" \
  SMTP_EGRESS_PROBE_TRIES=2 SMTP_EGRESS_PROBE_SLEEP=0 bash "$HC" 2>&1; }
rm -f "$TMP/him.argv"; out=$(RB); rc=$?
[ "$rc" = 0 ] && case "$out" in *"header-check: PASS"*"recorded PASS"*) true ;; *) false ;; esac \
  && ok "probe sent, read back, asserted PASS and recorded" || bad "read-back" "rc=$rc $out"
grep -qx "proxy.url = \"socks5h://127.0.0.1:$PORT\"" "$TMP/him.conf" && ok "read-back config carries the socks5h proxy" || bad "rb proxy" "$(cat "$TMP/him.conf" 2>/dev/null)"
grep -qx 'imap.sasl.plain.username = "probe@example.net"' "$TMP/him.conf" && grep -qx 'imap.server = "imap.example.net"' "$TMP/him.conf" \
  && ok "PROBE_IMAP_USER defaults to PROBE_RECIPIENT; PROBE_IMAP_SERVER used" || bad "rb user" "$(cat "$TMP/him.conf" 2>/dev/null)"
tr '\037' ' ' <"$TMP/him.argv" | grep -q 'message read -m INBOX --raw 77' && ok "reads the matched probe with message read --raw" || bad "rb read" "$(tr '\037' ' ' <"$TMP/him.argv")"
grep -q -- '--seen' "$TMP/him.argv" && bad "rb seen" "--seen passed" || ok "read-back never passes --seen"
[ -z "$(find "$TMP/rbstate" -name 'himalaya-*.toml')" ] && ok "read-back config removed" || bad "rb cleanup" "left"
out=$(STUB_HOP=198.51.100.99 RB); rc=$?
[ "$rc" = 1 ] && case "$out" in *"LEAK: 198.51.100.99"*) true ;; *) false ;; esac && ok "a leaking first hop read back → FAIL" || bad "rb leak" "rc=$rc $out"
grep -rl imaplib "$ROOT/scripts" | grep -v smtp-egress-guard.js | grep -q . && bad "no imaplib" "a script still uses imaplib" || ok "no script connects with imaplib"

echo "new-eml.sh"
printf 'Hello Bob,\nsee you on Friday.\n' >"$TMP/body.txt"
NE=$(SMTP_EGRESS_CONFIG="$TMP/config" bash "$ROOT/scripts/new-eml.sh" --to '"Doe, Bob" <bob@example.net>' --cc carol@example.net \
  --bcc dave@example.org --subject 'Grüße — plan' --body-file "$TMP/body.txt" 2>&1); rc=$?
[ "$rc" = 0 ] && case "$NE" in "$SE_STATE_DIR/outbox/"*.eml) true ;; *) false ;; esac && ok "writes to outbox/<msgid>.eml" || bad "path" "rc=$rc $NE"
python3 -I - "$NE" <<'PY' && ok "CRLF, UTC Date, Message-ID, MIME, utf-8, CTE, RFC 2047 Subject, From from msmtp" || bad "eml shape" "$(head -c 600 "$NE")"
import email, email.header, email.utils, os, stat, sys
raw = open(sys.argv[1], "rb").read()
head = raw.split(b"\r\n\r\n", 1)[0]
assert b"\n" not in head.replace(b"\r\n", b""), "bare LF in headers"
m = email.message_from_bytes(raw)
assert m["From"] == "alice@example.com", m["From"]
assert email.utils.parsedate_to_datetime(m["Date"]).utcoffset().total_seconds() == 0, m["Date"]
assert m["Message-ID"].startswith("<") and m["Message-ID"].endswith("@example.com>"), m["Message-ID"]
assert m["MIME-Version"] == "1.0"
assert m.get_content_type() == "text/plain" and m.get_content_charset() == "utf-8"
assert m["Content-Transfer-Encoding"]
assert "=?utf-8?" in m["Subject"].lower(), m["Subject"]
assert str(email.header.make_header(email.header.decode_header(m["Subject"]))) == "Grüße — plan"
assert [a for _, a in email.utils.getaddresses([m["To"]])] == ["bob@example.net"], m["To"]
assert m["Cc"] == "carol@example.net" and m["Bcc"] == "dave@example.org"
assert stat.S_IMODE(os.stat(sys.argv[1]).st_mode) == 0o600
PY
out=$(S --dry-run "$NE" 2>&1) && ok "send.sh --dry-run accepts what new-eml.sh wrote" || bad "new-eml → send" "$out"
bash "$ROOT/scripts/new-eml.sh" --subject x --body-file "$TMP/body.txt" >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok "no --to → exit 2" || bad "no --to" "rc=$rc"
bash "$ROOT/scripts/new-eml.sh" --to nobody --subject x --body-file "$TMP/body.txt" --from alice@example.com >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok "a --to that is not an address → exit 2" || bad "bad --to" "rc=$rc"

echo "msmtprc parsing (1.0.0 regression: from read without the password env)"
NE2=$(env -u SMTP_PW SMTP_EGRESS_CONFIG="$TMP/config" bash "$ROOT/scripts/new-eml.sh" --to bob@example.net --subject x --body-file "$TMP/body.txt" 2>&1); rc=$?
[ "$rc" = 0 ] && grep -q '^From: alice@example.com' "$NE2" && ok "new-eml.sh reads from with SMTP_PW unset (stub --pretend exits 78)" || bad "regression" "rc=$rc $NE2"
field() { SE_MSMTP_CONFIG="$1" SE_MSMTP_ACCOUNT="$2" se_msmtp_field "$3"; }
printf '# c\ndefaults\nfrom default@example.com\nport 587\n\naccount base\nuser base@example.com\n\naccount child : base\nfrom "child@example.com"\n\naccount plain\nhost h\n\naccount default : child\n' >"$TMP/rc-many"
[ "$(field "$TMP/rc-many" child from)" = child@example.com ] && ok "quoted from in a child account" || bad "child from" "$(field "$TMP/rc-many" child from)"
[ "$(field "$TMP/rc-many" child user)" = base@example.com ] && ok "user inherited from the parent account" || bad "inherit" "$(field "$TMP/rc-many" child user)"
[ "$(field "$TMP/rc-many" plain from)" = default@example.com ] && ok "from inherited from defaults" || bad "defaults" "$(field "$TMP/rc-many" plain from)"
[ "$(field "$TMP/rc-many" default from)" = child@example.com ] && ok "account default : child" || bad "default alias" "$(field "$TMP/rc-many" default from)"
[ -z "$(field "$TMP/rc-many" nosuch from)" ] && ok "unknown account → empty" || bad "unknown" "non-empty"
[ -z "$(field "$TMP/absent-rc" test from)" ] && ok "missing msmtprc → empty, no error" || bad "missing rc" "non-empty"
printf 'account t\nfrom t@example.com\npasswordeval "touch %s/pw-ran"\n' "$TMP" >"$TMP/rc-eval"
[ "$(field "$TMP/rc-eval" t from)" = t@example.com ] && [ ! -e "$TMP/pw-ran" ] && ok "passwordeval is read as text, never run" || bad "passwordeval" "ran"

echo "doctor.sh"
chmod 600 "$TMP/config"
D() { SMTP_EGRESS_CONFIG="${1:-$TMP/config}" bash "$ROOT/scripts/doctor.sh" >"$TMP/doc.out" 2>&1; }
D; rc=$?
[ "$rc" = 0 ] && ok "all rows ok → exit 0" || bad "doctor ok" "rc=$rc $(cat "$TMP/doc.out")"
grep -q 'SECRET-COMMAND' "$TMP/doc.out" && bad "doctor secret" "--pretend block printed" || ok "never prints the --pretend block"
awk '/── egress-check/{e=NR} /── proxy/{p=NR} END{exit !(e && p && e < p)}' "$TMP/doc.out" \
  && ok "SOCKS row comes after egress-check" || bad "order" "$(cat "$TMP/doc.out")"
grep -q 'probe-pass *: recorded' "$TMP/doc.out" && ok "reports the recorded probe PASS" || bad "probe-pass" "$(cat "$TMP/doc.out")"
D "$TMP/config-alias"; rc=$?
[ "$rc" = 0 ] && grep -q 'send-as *: WARN' "$TMP/doc.out" && ok "send-as alias → WARN row, still exit 0" || bad "doctor warn" "rc=$rc $(cat "$TMP/doc.out")"
chmod 644 "$TMP/config"; D; rc=$?; chmod 600 "$TMP/config"
[ "$rc" = 1 ] && grep -q 'config *: FAIL' "$TMP/doc.out" && ok "config not mode 600 → FAIL, exit 1" || bad "doctor mode" "rc=$rc"
grep -q 'himalaya *: himalaya v2.2.1' "$TMP/doc.out" && ok "doctor reports himalaya's version" || bad "doc him" "$(cat "$TMP/doc.out")"
grep -q 'imap *: reading configured: imap.gmail.com via socks5h://127.0.0.1:' "$TMP/doc.out" && ok "doctor imap row: reading configured (msmtp defaults)" || bad "doc imap" "$(cat "$TMP/doc.out")"
printf 'MSMTP_CONFIG=%s\nMSMTP_ACCOUNT=test\nSOCKS_PORT=%s\nIMAP_HOST=imap.example.net\nIMAP_PASSWORDEVAL=x\n' "$TMP/msmtprc" "$PORT" >"$TMP/config-legacy"; chmod 600 "$TMP/config-legacy"
D "$TMP/config-legacy"; rc=$?
[ "$rc" = 0 ] && grep -q 'imap-keys *: WARN — IMAP_HOST IMAP_PASSWORDEVAL are 1.0.x keys' "$TMP/doc.out" && ok "1.0.x IMAP keys → WARN, still exit 0" || bad "doc legacy" "rc=$rc $(cat "$TMP/doc.out")"
D "$TMP/absent"; rc=$?
[ "$rc" = 1 ] && ok "missing config → exit 1" || bad "doctor missing" "rc=$rc"
printf 'MSMTP_CONFIG=%s\nMSMTP_ACCOUNT=test\nSOCKS_PORT=%s\n' "$TMP/msmtprc" "$CLOSEDP" >"$TMP/config-closed"; chmod 600 "$TMP/config-closed"
D "$TMP/config-closed"; rc=$?
[ "$rc" = 1 ] && grep -q 'socks *: FAIL' "$TMP/doc.out" && ok "closed SOCKS port → FAIL, exit 1" || bad "doctor closed" "rc=$rc $(cat "$TMP/doc.out")"

echo "new-eml.sh threading"
NR=$(SMTP_EGRESS_CONFIG="$TMP/config" bash "$ROOT/scripts/new-eml.sh" --to bob@example.net --subject 'Re: Hello' \
  --body-file "$TMP/body.txt" --in-reply-to 'm2@example.net' --references '<m0@example.net> <m1@example.net>' 2>&1); rc=$?
[ "$rc" = 0 ] && grep -q $'^In-Reply-To: <m2@example.net>\r$' "$NR" && ok "--in-reply-to (brackets added)" || bad "irt" "rc=$rc $NR"
grep -q $'^References: <m0@example.net> <m1@example.net> <m2@example.net>\r$' "$NR" && ok "--references keeps the chain and ends with the parent" || bad "refs" "$(grep -i references "$NR")"
NR2=$(SMTP_EGRESS_CONFIG="$TMP/config" bash "$ROOT/scripts/new-eml.sh" --to bob@example.net --subject 'Re: x' --body-file "$TMP/body.txt" --in-reply-to '<p@example.net>' 2>&1)
grep -q $'^References: <p@example.net>\r$' "$NR2" && ok "--in-reply-to alone sets References to the parent" || bad "refs default" "$(grep -i references "$NR2")"
bash "$ROOT/scripts/new-eml.sh" --to bob@example.net --subject x --body-file "$TMP/body.txt" --from alice@example.com --in-reply-to 'not an id' >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok "a malformed --in-reply-to → exit 2" || bad "bad irt" "rc=$rc"
NE3=$(SMTP_EGRESS_CONFIG="$TMP/config" bash "$ROOT/scripts/new-eml.sh" --to bob@example.net --subject 'plain' --body-file "$TMP/body.txt" 2>&1)
grep -qiE '^(In-Reply-To|References):' "$NE3" && bad "no thread headers" "added without asking" || ok "no threading headers unless asked"

echo "doctor.sh send/read readiness, sweep, warnings"
printf 'MSMTP_CONFIG=%s\nMSMTP_ACCOUNT=test\nSOCKS_PORT=%s\nIMAP_USER=reader@example.com\nIMAP_PASSWORDCOMMAND=printenv R\n' "$TMP/absent-rc" "$PORT" >"$TMP/config-readonly"; chmod 600 "$TMP/config-readonly"
D "$TMP/config-readonly"; rc=$?
[ "$rc" = 1 ] && grep -q 'send-ready *: NO' "$TMP/doc.out" && grep -q 'read-ready *: yes' "$TMP/doc.out" \
  && ok "no msmtprc: not send-ready (exit 1) but read-ready" || bad "doc split" "rc=$rc $(cat "$TMP/doc.out")"
SMTP_EGRESS_CONFIG="$TMP/config-readonly" bash "$ROOT/scripts/doctor.sh" --read >"$TMP/doc.out" 2>&1; rc=$?
[ "$rc" = 0 ] && ok "doctor.sh --read exits 0 when read-ready, msmtp rows aside" || bad "doc --read" "rc=$rc $(cat "$TMP/doc.out")"
mkdir -p "$TMP/nohim"; for t in curl msmtp; do cp "$TMP/bin/$t" "$TMP/nohim/"; done
env PATH="$TMP/nohim:/usr/bin:/bin:$(dirname "$(command -v python3)"):$(dirname "$(command -v node)")" STUB_DIR="$TMP" \
  SMTP_EGRESS_CONFIG="$TMP/config" bash "$ROOT/scripts/doctor.sh" --read >"$TMP/doc.out" 2>&1; rc=$?
[ "$rc" = 1 ] && grep -q 'read-ready *: NO' "$TMP/doc.out" && ok "no himalaya → --read exits 1" || bad "doc nohim" "rc=$rc $(cat "$TMP/doc.out")"
bash "$ROOT/scripts/doctor.sh" --bogus >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok "doctor.sh with an unknown argument → exit 2" || bad "doc arg" "rc=$rc"
SD="$TMP/sweep/smtp-egress"; mkdir -p "$SD"
: >"$SD/himalaya-1-old.toml"; touch -t 202601010000 "$SD/himalaya-1-old.toml"; : >"$SD/himalaya-2-new.toml"
PATH="$TMP/bin:$PATH" STUB_DIR="$TMP" SMTP_EGRESS_CONFIG="$TMP/config" XDG_STATE_HOME="$TMP/sweep" bash "$ROOT/scripts/doctor.sh" >"$TMP/doc.out" 2>&1
[ ! -e "$SD/himalaya-1-old.toml" ] && [ -e "$SD/himalaya-2-new.toml" ] && grep -q 'removed 1 himalaya temp config' "$TMP/doc.out" \
  && ok "sweeps temp configs older than 1 h, keeps a fresh one" || bad "sweep" "$(ls "$SD") $(grep stale "$TMP/doc.out")"
printf 'MSMTP_CONFIG=%s\nMSMTP_ACCOUNT=test\nSOCKS_PORT=%s\nPROBE_IMAP_SERVER=imap.example.net\n' "$TMP/msmtprc" "$PORT" >"$TMP/config-half"; chmod 600 "$TMP/config-half"
D "$TMP/config-half"; rc=$?
[ "$rc" = 0 ] && grep -q 'probe-imap *: WARN — only one of PROBE_IMAP_SERVER' "$TMP/doc.out" && ok "only PROBE_IMAP_SERVER set → WARN" || bad "half 1" "rc=$rc $(cat "$TMP/doc.out")"
printf 'MSMTP_CONFIG=%s\nMSMTP_ACCOUNT=test\nSOCKS_PORT=%s\nPROBE_IMAP_PASSWORDCOMMAND=x\n' "$TMP/msmtprc" "$PORT" >"$TMP/config-half2"; chmod 600 "$TMP/config-half2"
D "$TMP/config-half2"
grep -q 'probe-imap *: WARN — only one of' "$TMP/doc.out" && ok "only PROBE_IMAP_PASSWORDCOMMAND set → WARN" || bad "half 2" "$(cat "$TMP/doc.out")"
D "$TMP/config-rb" 2>/dev/null; chmod 600 "$TMP/config-rb"; D "$TMP/config-rb"
grep -q 'probe-imap *: WARN' "$TMP/doc.out" && bad "both set" "warned with both keys set" || ok "both PROBE_IMAP keys set → no WARN"
printf 'MSMTP_CONFIG=%s\nMSMTP_ACCOUNT=test\nSOCKS_PORT=%s\nIMAP_HOST=imap.example.net\nIMAP_USER=probe@example.net\n' "$TMP/msmtprc" "$PORT" >"$TMP/config-leguser"; chmod 600 "$TMP/config-leguser"
D "$TMP/config-leguser"
grep -q 'imap-keys *: WARN — IMAP_HOST IMAP_USER are 1.0.x keys' "$TMP/doc.out" && ok "IMAP_USER next to IMAP_HOST is named as a 1.0.x key" || bad "leg user warn" "$(grep imap-keys "$TMP/doc.out")"

echo
echo "passed ${pass}, failed ${fail}"
[ "$fail" -eq 0 ]
