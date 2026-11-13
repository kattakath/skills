#!/usr/bin/env bash
# send.sh [--dry-run] <message.eml> — send one plain-text email through the SOCKS5 proxy.
#
#   1. egress-check (abort if the proxy is not a different exit)
#   2. the .eml has From/To/Subject/Date (a missing Message-ID is generated and written
#      back), and its From matches the msmtp account's `from`
#   3. every recipient is on ALLOWLIST_FILE, when one is configured
#   4. msmtp with --proxy-host/--proxy-port passed EXPLICITLY, so an msmtprc without proxy
#      lines still goes through the proxy; --logfile=- so smtpstatus is always reported
#   5. require smtpstatus=250, then append one JSON line (no body) to sent.jsonl
#
# --dry-run runs every step except msmtp and the sent.jsonl append; it prints the line
# that would be logged. Run it first: it adds a missing Message-ID, so the sha256 in the
# approval prompt of the real send matches the one logged.
#
# Exit: 0 sent (or dry run ok), 1 refused or not accepted (never retried), 2 config error.
#
# The plugin never reads a secret: msmtp's own `passwordeval` does. The account's from and
# user are read from the msmtprc file itself (se_msmtp_field), never via passwordeval.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=egress-check.sh
. "$HERE/egress-check.sh"

die() { echo "send.sh: REFUSED — $*" >&2; exit 1; }
die_config() { echo "send.sh: CONFIG — $*" >&2; exit 2; }

se_sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1; fi
}

# Validates the headers and adds a Message-ID when missing (rewriting the file in place).
# Prints one JSON object: from, message_id, subject, to/cc/bcc (address arrays).
se_eml_fields() {
  python3 -I - "$1" <<'PY'
import email, email.policy, email.utils, json, sys, uuid

p = sys.argv[1]
raw = open(p, "rb").read()
msg = email.message_from_bytes(raw, policy=email.policy.compat32)
missing = [h for h in ("From", "To", "Subject", "Date") if not msg.get(h)]
if missing:
    print("missing header(s): " + ", ".join(missing), file=sys.stderr)
    sys.exit(3)
frm = email.utils.parseaddr(msg["From"])[1].lower()
if "@" not in frm:
    print("From has no address", file=sys.stderr)
    sys.exit(3)
mid = (msg.get("Message-ID") or "").strip()
if not mid:
    mid = f"<{uuid.uuid4()}@{frm.split('@', 1)[1]}>"
    nl = b"\r\n" if b"\r\n" in raw.split(b"\n\n", 1)[0] else b"\n"
    with open(p, "wb") as f:
        f.write(b"Message-ID: " + mid.encode() + nl + raw)
group = lambda h: [a.lower() for _, a in email.utils.getaddresses(msg.get_all(h, [])) if a]
print(json.dumps({
    "from": frm, "message_id": mid, "subject": " ".join(str(msg["Subject"]).split()),
    "to": group("To"), "cc": group("Cc"), "bcc": group("Bcc"),
}))
PY
}

# Every recipient must match an address or an @domain line of the allowlist.
se_allowlisted() { # allowlist-file fields-json
  python3 -I - "$1" "$2" <<'PY'
import json, sys
allow = set()
for line in open(sys.argv[1]):
    line = line.split("#", 1)[0].strip().lower()
    if line:
        allow.add(line)
f = json.loads(sys.argv[2])
bad = [r for r in f["to"] + f["cc"] + f["bcc"] if r not in allow and "@" + r.split("@")[-1] not in allow]
if bad:
    print("not on ALLOWLIST_FILE: " + ", ".join(bad), file=sys.stderr)
    sys.exit(1)
PY
}

se_send_main() {
  local dry=0 eml=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry=1 ;;
      -h | --help) sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
      -*) die_config "unknown option $1" ;;
      *) [ -z "$eml" ] || die_config "one .eml at a time"; eml="$1" ;;
    esac
    shift
  done
  [ -n "$eml" ] || die_config "usage: send.sh [--dry-run] <message.eml>"
  [ -f "$eml" ] && [ -r "$eml" ] || die_config "cannot read $eml"

  se_load_config
  [ -r "$SE_CONFIG_FILE" ] || die_config "no config at $SE_CONFIG_FILE"
  [ -n "$SE_MSMTP_CONFIG" ] && [ -r "$SE_MSMTP_CONFIG" ] || die_config "MSMTP_CONFIG unset or unreadable"
  [ -n "$SE_MSMTP_ACCOUNT" ] || die_config "MSMTP_ACCOUNT unset"
  command -v msmtp >/dev/null 2>&1 || die_config "msmtp is not on PATH"

  # 1. egress
  local egress proxied
  egress=$(se_egress_main) || die "egress-check failed (see above)"
  proxied=$(printf '%s' "$egress" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["proxied"])')

  # 2. headers + From
  local fields from acct_from acct_user
  fields=$(se_eml_fields "$eml") || die "bad .eml"
  from=$(printf '%s' "$fields" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["from"])')
  acct_from=$(se_msmtp_field from | tr '[:upper:]' '[:lower:]')
  acct_user=$(se_msmtp_field user | tr '[:upper:]' '[:lower:]')
  [ -n "$acct_from" ] && [ "$acct_from" != "(not set)" ] || die_config "msmtp account '$SE_MSMTP_ACCOUNT' has no from"
  [ "$from" = "$acct_from" ] || die "From <$from> does not match the msmtp account's from <$acct_from>"
  if [ -n "$acct_user" ] && [ "$acct_user" != "(not set)" ] && [ "$acct_user" != "$acct_from" ]; then
    echo "send.sh: WARN — the account's from <$acct_from> differs from its login user: a send-as alias, so the provider will add a Sender: header naming the login" >&2
  fi

  # 3. allowlist
  if [ -n "$SE_ALLOWLIST_FILE" ]; then
    [ -r "$SE_ALLOWLIST_FILE" ] || die_config "ALLOWLIST_FILE unreadable"
    se_allowlisted "$SE_ALLOWLIST_FILE" "$fields" || die "recipient not allowlisted"
  fi

  local sha
  sha=$(se_sha256 "$eml")

  # 4. send — once. A non-250 is reported and never retried here.
  local log status
  if [ "$dry" = 1 ]; then
    status="dry-run"
  else
    log=$(msmtp -C "$SE_MSMTP_CONFIG" -a "$SE_MSMTP_ACCOUNT" \
      --proxy-host="$SE_SOCKS_HOST" --proxy-port="$SE_SOCKS_PORT" \
      --logfile=- --read-recipients <"$eml" 2>&1)
    status=$(printf '%s\n' "$log" | sed -n 's/.*smtpstatus=\([0-9][0-9]*\).*/\1/p' | tail -1)
    # 5. require 250
    if [ "$status" != 250 ]; then
      printf '%s\n' "$log" | grep -E 'smtpstatus|smtpmsg|errormsg|msmtp:' | tail -3 >&2
      die "msmtp did not report smtpstatus=250 (got ${status:-none}); not retried"
    fi
  fi

  local line
  line=$(python3 -I -c '
import json, sys, datetime
f = json.loads(sys.argv[1])
print(json.dumps({
    "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "message_id": f["message_id"], "to": f["to"], "cc": f["cc"], "bcc": f["bcc"],
    "subject": f["subject"], "sha256": sys.argv[2], "proxied_ip": sys.argv[3],
    "smtpstatus": sys.argv[4],
}))' "$fields" "$sha" "$proxied" "$status")

  if [ "$dry" = 1 ]; then
    echo "send.sh: DRY RUN ok — would log: $line"
  else
    mkdir -p "$SE_STATE_DIR"
    printf '%s\n' "$line" >>"$SE_STATE_DIR/sent.jsonl"
    echo "send.sh: SENT smtpstatus=250 — $line"
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  se_send_main "$@"
  exit $?
fi
