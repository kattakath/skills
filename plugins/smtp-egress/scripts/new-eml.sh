#!/usr/bin/env bash
# new-eml.sh --to ADDR [--to …] [--cc ADDR …] [--bcc ADDR …] --subject TEXT --body-file FILE [--from ADDR]
#
# Writes a send-ready plain-text .eml to $XDG_STATE_HOME/smtp-egress/outbox/<msgid>.eml
# and prints its path. Built with Python's email package (policy SMTP), so it has:
#   CRLF line ends, an RFC 5322 Date (UTC, so no time zone leaks), a Message-ID, MIME-Version 1.0,
#   Content-Type: text/plain; charset=utf-8, a Content-Transfer-Encoding chosen for the
#   body (7bit, or quoted-printable/base64 when it is not short-lined ASCII), and an
#   RFC 2047 encoded Subject when the Subject is not ASCII.
# From defaults to the msmtp account's `from`, so send.sh's From check passes.
#
# Exit: 0 written, 2 usage or config error. Sends nothing.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=egress-check.sh
. "$HERE/egress-check.sh"

die_config() { echo "new-eml.sh: $*" >&2; exit 2; }

to=() cc=() bcc=() subject="" body="" from="" have_subject=0
while [ $# -gt 0 ]; do
  case "$1" in
    --to) to+=("${2:-}"); shift ;;
    --cc) cc+=("${2:-}"); shift ;;
    --bcc) bcc+=("${2:-}"); shift ;;
    --subject) subject="${2:-}"; have_subject=1; shift ;;
    --body-file) body="${2:-}"; shift ;;
    --from) from="${2:-}"; shift ;;
    -h | --help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die_config "unknown argument $1" ;;
  esac
  shift
done
[ "${#to[@]}" -gt 0 ] || die_config "at least one --to is required"
[ "$have_subject" = 1 ] || die_config "--subject is required"
[ -n "$body" ] && [ -r "$body" ] || die_config "--body-file must name a readable file"

if [ -z "$from" ]; then
  se_load_config
  [ -n "$SE_MSMTP_CONFIG" ] && [ -n "$SE_MSMTP_ACCOUNT" ] || die_config "no --from and no MSMTP_CONFIG/MSMTP_ACCOUNT to read it from"
  from=$(se_msmtp_field from)
  [ -n "$from" ] && [ "$from" != "(not set)" ] || die_config "the msmtp account has no from"
fi

outbox="$SE_STATE_DIR/outbox"
mkdir -p "$outbox"

# Joined with the unit separator, since a display name may itself contain a comma.
join() { local IFS=$'\x1f'; printf '%s' "$*"; }
python3 -I - "$outbox" "$from" "$(join "${to[@]}")" "$(join "${cc[@]+"${cc[@]}"}")" "$(join "${bcc[@]+"${bcc[@]}"}")" "$subject" "$body" <<'PY' || exit 2
import datetime, email.policy, email.utils, os, re, sys
from email.message import EmailMessage

outbox, frm, to, cc, bcc, subject, body_path = sys.argv[1:8]
for name, v in (("from", frm), ("to", to), ("cc", cc), ("bcc", bcc)):
    for a in filter(None, v.split("\x1f")):
        if "@" not in email.utils.parseaddr(a)[1]:
            print(f"new-eml.sh: not an address in --{name}: {a!r}", file=sys.stderr)
            sys.exit(2)
body = open(body_path, encoding="utf-8").read()
m = EmailMessage(policy=email.policy.SMTP)
m["From"] = frm
m["To"] = ", ".join(filter(None, to.split("\x1f")))
if cc:
    m["Cc"] = ", ".join(filter(None, cc.split("\x1f")))
if bcc:
    m["Bcc"] = ", ".join(filter(None, bcc.split("\x1f")))
m["Subject"] = subject
# UTC on purpose: a local offset would tell the recipient the sender's time zone.
m["Date"] = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))  # "+0000"
domain = email.utils.parseaddr(frm)[1].rpartition("@")[2]
mid = email.utils.make_msgid(domain=domain)
m["Message-ID"] = mid
m.set_content(body, subtype="plain", charset="utf-8")
name = re.sub(r"[^A-Za-z0-9._@-]", "_", mid.strip("<>")) + ".eml"
out = os.path.join(outbox, name)
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "wb") as f:
    f.write(m.as_bytes())
print(out)
PY
