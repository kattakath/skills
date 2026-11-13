#!/usr/bin/env bash
# header-check.sh — prove, from a delivered message's headers, that the sender's own IP
# never reached them.
#
#   header-check.sh [--dry-run]
#       Build a probe .eml to PROBE_RECIPIENT and send it through send.sh. Then, if the
#       IMAP_* keys are set, read the headers back over IMAP (BODY.PEEK[HEADER], searched
#       by Message-ID) and assert on them. Otherwise print the Message-ID and a checklist
#       for whatever mail reader the agent has (save the raw headers, then use --headers).
#
#   header-check.sh --headers <file> [--direct-v4 IP] [--direct-v6 IP] [--from-domain D]
#       Assert on a saved header block. Direct IPs are measured when not given.
#
# Exit: 0 PASS, 1 FAIL or refused, 2 config error.
#
# A PASS for a probe this script sent (IMAP read-back, or --headers on that probe's saved
# headers) is recorded as $XDG_STATE_HOME/smtp-egress/probe-<key>.pass, where <key> hashes
# the msmtp account and the SOCKS endpoint; doctor.sh reports whether it exists.
#
# Asserts: no Received: hop IP (the first one included) is in the direct IPv4 /24 or
# IPv6 /48; no Sender: header; dmarc=pass; dkim=pass. A DKIM d= that is not the From
# domain is a WARNING, not a failure (d=*.gappssmtp.com is cosmetic).
#
# PROBE_RECIPIENT must be OUTSIDE the sending account: a self-send never leaves the
# provider, so it skips the external hop and DKIM and proves nothing.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=egress-check.sh
. "$HERE/egress-check.sh"

die() { echo "header-check: REFUSED — $*" >&2; exit 1; }
die_config() { echo "header-check: CONFIG — $*" >&2; exit 2; }

# Same mailbox? Lowercase, drop a display name and a +tag, and drop the dots of a
# gmail.com/googlemail.com local part. Provider-side aliases beyond that are invisible here.
se_same_mailbox() {
  python3 -I - "$1" "$2" <<'PY'
import email.utils, os, sys
# Domains whose local part ignores dots; the first is canonical. Overridable so the tests
# need no real-provider address.
DOTLESS = [d.strip().lower() for d in os.environ.get("SMTP_EGRESS_DOTLESS_DOMAINS", "gmail.com,googlemail.com").split(",") if d.strip()]
def norm(a):
    a = email.utils.parseaddr(a)[1].strip().lower()
    local, _, dom = a.rpartition("@")
    local = local.split("+", 1)[0]
    if dom in DOTLESS:
        local, dom = local.replace(".", ""), DOTLESS[0]
    return f"{local}@{dom}"
sys.exit(0 if norm(sys.argv[1]) == norm(sys.argv[2]) else 1)
PY
}

# Record a PASS when the headers belong to a probe this script built (its .eml is in the
# state dir), keyed to the current msmtp account + SOCKS endpoint.
se_record_pass() { # headers-file
  local mid probe
  mid=$(python3 -I -c '
import email, sys
print((email.message_from_binary_file(open(sys.argv[1], "rb")).get("Message-ID") or "").strip())' "$1")
  case "$mid" in "<smtp-egress-probe-"*) ;; *) return 0 ;; esac
  probe=$(grep -lF "Message-ID: $mid" "$SE_STATE_DIR"/probe-*.eml 2>/dev/null | head -1)
  [ -n "$probe" ] || return 0
  se_load_config
  [ -n "$SE_MSMTP_ACCOUNT" ] || return 0
  local marker
  marker=$(se_probe_marker)
  printf '{"ts": "%s", "message_id": "%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$mid" >"$marker"
  echo "header-check: recorded PASS at $marker"
}

# Args: headers-file direct-v4 direct-v6 from-domain. Exit 0 pass, 1 fail.
se_assert_headers() {
  python3 -I - "$@" <<'PY'
import email, email.policy, email.utils, ipaddress, re, sys

path, d4, d6, from_dom = (sys.argv[1:5] + ["", "", "", ""])[:4]
raw = open(path, "rb").read()
end = re.search(rb"\r?\n\r?\n", raw)
msg = email.message_from_bytes(raw[: end.start()] if end else raw, policy=email.policy.compat32)

def ip(s):
    try:
        return ipaddress.ip_address(s) if s else None
    except ValueError:
        return None

D4, D6 = ip(d4), ip(d6)
N4 = ipaddress.ip_network(f"{D4}/24", strict=False) if D4 else None
N6 = ipaddress.ip_network(f"{D6}/48", strict=False) if D6 else None
if not from_dom:
    from_dom = email.utils.parseaddr(msg.get("From", ""))[1].rpartition("@")[2].lower()

fails, warns, info = [], [], []
if not (D4 or D6):
    fails.append("no direct IP to compare against")

# Received headers are prepended, so the LAST one is the first hop.
received = [" ".join(str(h).split()) for h in msg.get_all("Received", [])]
# In `from HELO (rdns [IP]) by …` the connecting IP is the LAST bracketed one before
# ` by `; the HELO may itself be a bracketed (often private) literal. Every IP in the
# from-clause is checked, and the connecting one is reported as the hop.
hops, seen = [], []
for h in reversed(received):
    m = re.match(r"from\s(.*?)(?:\sby\s|$)", h)
    ips = [ip(x) for x in re.findall(r"\[(?:IPv6:)?([0-9A-Fa-f:.]+)\]", m.group(1))] if m else []
    ips = [a for a in ips if a]
    if ips:
        hops.append(ips[-1])
        seen.extend(ips)
if not received:
    fails.append("no Received: headers (was this a self-send?)")
elif not hops:
    fails.append("no Received: from ... [IP] hop found")
else:
    info.append(f"first hop IP {hops[0]}")
for a in seen + [ip(x.strip(" []")) for x in msg.get_all("X-Originating-IP", [])]:
    if a and ((a.version == 4 and N4 and a in N4) or (a.version == 6 and N6 and a in N6) or a in (D4, D6)):
        fails.append(f"LEAK: {a} is in the direct {'/24' if a.version == 4 else '/48'}")

if msg.get("Sender"):
    fails.append("Sender: header present (a send-as alias adds the primary account)")

auth = " ".join(" ".join(str(h).split()) for h in msg.get_all("Authentication-Results", []) + msg.get_all("ARC-Authentication-Results", []))
for k in ("dmarc", "dkim"):
    if not re.search(rf"\b{k}=pass\b", auth, re.I):
        fails.append(f"{k}=pass not found in Authentication-Results")

ds = [m.group(1).lower() for h in msg.get_all("DKIM-Signature", []) for m in [re.search(r"\bd=([^;\s]+)", str(h))] if m]
if ds and from_dom and not any(d == from_dom or d.endswith("." + from_dom) for d in ds):
    warns.append(f"DKIM d={','.join(ds)} is not the From domain {from_dom} (cosmetic: the domain's own DKIM signing is not enabled)")

for x in info:
    print(f"  info  {x}")
for x in warns:
    print(f"  WARN  {x}")
for x in fails:
    print(f"  FAIL  {x}")
print("header-check: " + ("PASS" if not fails else "FAIL"))
sys.exit(1 if fails else 0)
PY
}

se_measure_direct() {
  D4=$(se_trace_ip -4); D6=$(se_trace_ip -6)
}

se_header_main() {
  local dry="" hfile="" D4="" D6="" fdom="" given=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry="--dry-run" ;;
      --headers) hfile="${2:-}"; shift ;;
      --direct-v4) D4="${2:-}"; given=1; shift ;;
      --direct-v6) D6="${2:-}"; given=1; shift ;;
      --from-domain) fdom="${2:-}"; shift ;;
      -h | --help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
      *) die_config "unknown argument $1" ;;
    esac
    shift
  done

  if [ -n "$hfile" ]; then
    [ -r "$hfile" ] || die_config "cannot read $hfile"
    [ "$given" = 1 ] || se_measure_direct
    se_assert_headers "$hfile" "$D4" "$D6" "$fdom" || return 1
    se_record_pass "$hfile"
    return 0
  fi

  se_load_config
  [ -n "$SE_PROBE_RECIPIENT" ] || die_config "PROBE_RECIPIENT unset in $SE_CONFIG_FILE"
  [ -n "$SE_MSMTP_CONFIG" ] && [ -n "$SE_MSMTP_ACCOUNT" ] || die_config "MSMTP_CONFIG / MSMTP_ACCOUNT unset"
  local from
  from=$(se_msmtp_field from)
  [ -n "$from" ] && [ "$from" != "(not set)" ] || die_config "msmtp account has no from"
  if se_same_mailbox "$from" "$SE_PROBE_RECIPIENT"; then
    die "PROBE_RECIPIENT is the sending mailbox (after lowercasing, +tag and Gmail-dot normalisation) — a self-send skips the external hop and DKIM"
  fi

  mkdir -p "$SE_STATE_DIR"
  local ts eml mid
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  eml="$SE_STATE_DIR/probe-$ts.eml"
  mid="<smtp-egress-probe-$ts-$$@${from##*@}>"
  {
    printf 'From: %s\r\nTo: %s\r\nSubject: smtp-egress header probe %s\r\n' "$from" "$SE_PROBE_RECIPIENT" "$ts"
    printf 'Date: %s\r\nMessage-ID: %s\r\nMIME-Version: 1.0\r\n' "$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')" "$mid"
    printf 'Content-Type: text/plain; charset=utf-8\r\n\r\n'
    printf 'Header probe from smtp-egress. Safe to delete.\r\n'
  } >"$eml"

  bash "$HERE/send.sh" ${dry:+"$dry"} "$eml" || die "send.sh failed"
  [ -z "$dry" ] || { echo "header-check: DRY RUN — probe built at $eml, nothing sent"; return 0; }

  se_measure_direct
  if [ -z "$SE_IMAP_HOST" ]; then
    cat <<EOF
header-check: probe SENT. Message-ID: $mid
No IMAP_* config, so verify it with the mail reader you have:
  1. open the message with that Message-ID in $SE_PROBE_RECIPIENT's mailbox (check spam too)
  2. save its RAW headers ("show original") to a file
  3. run: bash "\${CLAUDE_PLUGIN_ROOT}/scripts/header-check.sh" --headers <file> --direct-v4 '${D4}' --direct-v6 '${D6}'
     It asserts: no Received hop in the direct /24 or /48, no Sender:, dmarc=pass, dkim=pass.
EOF
    return 0
  fi

  local hdr="$SE_STATE_DIR/probe-$ts.headers"
  python3 -I - "$SE_IMAP_HOST" "${SE_IMAP_PORT:-993}" "${SE_IMAP_USER:-$SE_PROBE_RECIPIENT}" \
    "${SE_IMAP_MAILBOX:-INBOX}" "$mid" "$hdr" "$SE_IMAP_PASSWORDEVAL" <<'PY' || die "IMAP read-back failed"
import imaplib, subprocess, sys, time
host, port, user, box, mid, out, pw_cmd = sys.argv[1:8]
if not pw_cmd:
    print("IMAP_PASSWORDEVAL unset", file=sys.stderr); sys.exit(1)
# The password goes straight into login(); it is never printed or written.
pw = subprocess.run(["sh", "-c", pw_cmd], capture_output=True, text=True, check=True).stdout.rstrip("\n")
m = imaplib.IMAP4_SSL(host, int(port))
m.login(user, pw)
del pw
# The probe may land in spam: search the mailbox, then [Gmail]/Spam when it exists.
typ, listing = m.list()
names = [l.decode(errors="replace") for l in (listing or []) if l]
boxes = [box] + (["[Gmail]/Spam"] if any(n.endswith('"[Gmail]/Spam"') or n.endswith(" [Gmail]/Spam") for n in names) else [])
for _ in range(24):
    for b in boxes:
        if m.select(f'"{b}"', readonly=True)[0] != "OK":
            continue
        typ, data = m.search(None, "HEADER", "Message-ID", mid)
        ids = data[0].split() if typ == "OK" and data and data[0] else []
        if ids:
            typ, msg = m.fetch(ids[-1], "(BODY.PEEK[HEADER])")
            open(out, "wb").write(msg[0][1])
            m.logout(); sys.exit(0)
    time.sleep(5)
print(f"message {mid} not found in {', '.join(boxes)} after 120 s", file=sys.stderr)
m.logout(); sys.exit(1)
PY
  se_assert_headers "$hdr" "$D4" "$D6" "${from##*@}" || return 1
  se_record_pass "$hdr"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  se_header_main "$@"
  exit $?
fi
