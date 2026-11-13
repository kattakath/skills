#!/usr/bin/env bash
# the single-quoted ${CLAUDE_PLUGIN_ROOT} and $( ) are literal commands fed to the guard.
# shellcheck disable=SC2016
# Case suite for smtp-egress-guard.js (harness shape copied from mac-app-send's).
#
# Every case exits 0 (a match ASKS, it never denies), so each is classified from stdout:
#   ask   — exit 0 and stdout is hook JSON with permissionDecision "ask"
#   allow — exit 0 and stdout is EMPTY
# Both halves, because each fails differently:
#   must-ASK    — a rule that stopped matching lets an email leave with no human in the loop
#   must-ALLOW  — an over-broad rule prompts on reading or grepping, which trains the
#                 operator to click through the one prompt that matters
#   never-throw — the guard fails OPEN on any error, so a throw disarms every rule silently
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARD="$ROOT/scripts/smtp-egress-guard.js"
SEND="$ROOT/scripts/send.sh"
pass=0; fail=0

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
EML="$TMP/msg.eml"
printf 'From: Alice <alice@example.com>\r\nTo: bob@example.net\r\nSubject: Quarterly notes\r\nDate: Thu, 12 Nov 2026 10:00:00 +0000\r\nMessage-ID: <t1@example.com>\r\n\r\nHello.\r\n' >"$EML"
SHA12=$( (shasum -a 256 "$EML" 2>/dev/null || sha256sum "$EML") | cut -c1-12)

# Hook JSON for a Bash command, built by node so no case needs hand-escaped JSON.
mk() { # command [cwd]
  node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",tool_input:{command:process.argv[1]},cwd:process.argv[2]||"/tmp"}))' "$1" "${2:-}"
}

# Prints ask | allow | other(<detail>). Decodes the JSON rather than grepping it.
run() {
  local out rc
  out=$(printf '%s' "$1" | node "$GUARD" 2>/dev/null); rc=$?
  [ "$rc" = 0 ] || { echo "other(exit=$rc)"; return; }
  [ -z "$out" ] && { echo allow; return; }
  printf '%s' "$out" | node -e '
    let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
      try {
        const h = JSON.parse(s).hookSpecificOutput || {};
        const ok = h.hookEventName === "PreToolUse" && h.permissionDecision === "ask"
          && typeof h.permissionDecisionReason === "string" && h.permissionDecisionReason.length > 0;
        console.log(ok ? "ask" : "other(json)");
      } catch { console.log("other(not-json)"); }
    });'
}

reason() { printf '%s' "$1" | node "$GUARD" 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", (x) => (s += x)).on("end", () => {
    try { console.log(JSON.parse(s).hookSpecificOutput.permissionDecisionReason); } catch { console.log(""); }
  });'; }

expect() { # name json want(ask|allow)
  local got; got=$(run "$2")
  if [ "$got" = "$3" ]; then
    printf '  ok    %-58s %s\n' "$1" "$got"; pass=$((pass+1))
  else
    printf '  FAIL  %-58s want=%s got=%s\n' "$1" "$3" "$got"; fail=$((fail+1))
  fi
}

# The reason must carry a given substring (verdict first, then the facts).
contains() { # name json needle
  local r; r=$(reason "$2")
  case "$r" in
    *"$3"*) printf '  ok    %-58s has %s\n' "$1" "$3"; pass=$((pass+1)) ;;
    *) printf '  FAIL  %-58s missing %s in: %s\n' "$1" "$3" "$r"; fail=$((fail+1)) ;;
  esac
}

one_line() { # name json
  local r; r=$(reason "$2")
  if [ -n "$r" ] && [[ "$r" != *$'\n'* && "$r" != *$'\r'* ]]; then
    printf '  ok    %-58s one line\n' "$1"; pass=$((pass+1))
  else
    printf '  FAIL  %-58s reason=%s\n' "$1" "$r"; fail=$((fail+1))
  fi
}

DEEP_MAIL=$(python3 -I -c 'print("echo " + "$(" * 5000 + "msmtp -t" + ")" * 5000)')
DEEP_LS=$(python3 -I -c 'print("echo " + "$(" * 5000 + "ls" + ")" * 5000)')

echo "must ASK — the plugin's scripts, wherever they live"
expect "S=/x; bash \"\$S/send.sh\" m.eml (review C1)"      "$(mk 'S=/x; bash "$S/send.sh" m.eml')" ask
expect "\"\$S/send.sh\" m.eml run as the command word"     "$(mk '"$S/send.sh" m.eml')" ask
expect "bash …/smtp-egress/scripts/send.sh msg.eml"        "$(mk "bash $SEND $EML")" ask
expect "send.sh via \${CLAUDE_PLUGIN_ROOT}"               "$(mk 'bash "${CLAUDE_PLUGIN_ROOT}/scripts/send.sh" /tmp/none.eml')" ask
expect "send.sh run directly by absolute path"             "$(mk "cd /tmp && $SEND $EML")" ask
expect "cd elsewhere && ./send.sh (any location)"          "$(mk 'cd /tmp/work && ./send.sh m.eml')" ask
expect "bash send.sh (relative, outside the plugin)"       "$(mk 'bash send.sh m.eml')" ask
expect "source send.sh"                                    "$(mk 'source ./send.sh m.eml')" ask
expect ". send.sh"                                         "$(mk '. /opt/x/send.sh m.eml')" ask
expect "send.sh under env + VAR= prefix"                   "$(mk "env X=1 bash $SEND $EML")" ask
expect "sudo -u X -g Y bash send.sh"                       "$(mk 'sudo -u mailer -g staff bash send.sh m.eml')" ask
expect "--dry-run only inside a # comment"                 "$(mk 'bash send.sh m.eml # --dry-run')" ask
expect "--dry-run only as a redirect target"               "$(mk 'bash send.sh m.eml > --dry-run')" ask
expect "header-check.sh (sends a real probe)"              "$(mk 'bash "${CLAUDE_PLUGIN_ROOT}/scripts/header-check.sh"')" ask
expect "header-check.sh --headers with no value"           "$(mk 'bash header-check.sh --headers')" ask
expect "header-check.sh --headers --dry-run (value eaten)" "$(mk 'bash header-check.sh --headers --dry-run')" ask
expect "header-check.sh --direct-v4 --dry-run (value)"     "$(mk 'bash header-check.sh --direct-v4 --dry-run')" ask
expect "header-check.sh --from-domain only"                "$(mk 'bash header-check.sh --from-domain example.com')" ask
expect "header-check.sh unknown flag"                      "$(mk 'bash header-check.sh --yes')" ask

echo "must ASK — raw bypass shapes"
expect "msmtp -t run directly"                             "$(mk "msmtp -t < $EML")" ask
expect "msmtp with an account and a recipient"             "$(mk 'msmtp -C ~/.msmtprc -a work bob@example.net < m.eml')" ask
expect "sudo /usr/bin/msmtp"                               "$(mk 'sudo /usr/bin/msmtp -t < m.eml')" ask
expect "sudo -u X msmtp"                                   "$(mk 'sudo -u mailer msmtp -t < m.eml')" ask
expect "timeout -s KILL 5 msmtp"                           "$(mk 'timeout -s KILL 5 msmtp -t < m.eml')" ask
expect "nice -n 5 sendmail"                                "$(mk 'nice -n 5 sendmail -t < m.eml')" ask
expect "time -p msmtp"                                     "$(mk 'time -p msmtp -t < m.eml')" ask
expect "env -i PATH=… msmtp"                               "$(mk 'env -i PATH=/usr/bin msmtp -t < m.eml')" ask
expect "env -S 'msmtp -t'"                                 "$(mk "env -S 'msmtp -t' < m.eml")" ask
expect "xargs -n 1 msmtp"                                  "$(mk 'ls *.eml | xargs -n 1 msmtp -t')" ask
expect "find -exec msmtp"                                  "$(mk "find . -name '*.eml' -exec msmtp -t {} \;")" ask
expect "nix shell … -c msmtp"                              "$(mk 'nix shell nixpkgs#msmtp -c msmtp -t < m.eml')" ask
expect "msmtp inside bash -c"                              "$(mk "bash -c 'msmtp -t < m.eml'")" ask
expect "msmtp inside bash -lc"                             "$(mk "bash -lc 'msmtp -t < m.eml'")" ask
expect "sendmail inside sh -ec"                            "$(mk "sh -ec 'sendmail -t < m.eml'")" ask
expect "msmtp inside \$( )"                                "$(mk 'r=$(msmtp -t < m.eml); echo $r')" ask
expect "eval \"msmtp …\""                                  "$(mk 'eval "msmtp -t < m.eml"')" ask
expect "cat <<EOF | bash (heredoc piped to a shell)"       "$(mk $'cat <<EOF | bash\nmsmtp -t < m.eml\nEOF')" ask
expect "echo '…' | sh"                                     "$(mk "echo 'msmtp -t < m.eml' | sh")" ask
expect "bash <<EOF heredoc on stdin"                       "$(mk $'bash <<EOF\nsendmail -t < m.eml\nEOF')" ask
expect "\$MSMTP -t (variable command word)"                "$(mk 'MSMTP=/usr/bin/msmtp; $MSMTP -t < m.eml')" ask
expect "5000-deep \$( around msmtp"                        "$(mk "$DEEP_MAIL")" ask
expect "sendmail -t"                                       "$(mk 'sendmail -t < m.eml')" ask
expect "swaks"                                             "$(mk 'swaks --to bob@example.net --server smtp.example.com')" ask
expect "mail -s … recipient"                               "$(mk 'mail -s hello bob@example.net < body.txt')" ask
expect "mailx -c recipient"                                "$(mk 'mailx -s x -c bob@example.net < body.txt')" ask
expect "mutt recipient"                                    "$(mk 'mutt -s x bob@example.net < body.txt')" ask
expect "curl smtps:// URL"                                 "$(mk 'curl --ssl-reqd smtps://smtp.example.com:465 --mail-rcpt bob@example.net -T m.eml')" ask
expect "curl --url=smtp:// URL"                            "$(mk 'curl --url=smtp://smtp.example.com:587 -T m.eml')" ask
expect "python3 -c smtplib.SMTP("                          "$(mk "python3 -c 'import smtplib; s=smtplib.SMTP(\"smtp.example.com\", 587)'")" ask
expect "python heredoc smtplib.SMTP_SSL("                  "$(mk $'python3 - <<EOF\nimport smtplib\nsmtplib.SMTP_SSL("smtp.example.com", 465)\nEOF')" ask
expect "openssl s_client to :587"                          "$(mk 'openssl s_client -starttls smtp -connect smtp.example.com:587')" ask
expect "openssl s_client to :465"                          "$(mk 'openssl s_client -connect smtp.example.com:465 -quiet')" ask
expect "nc host 25"                                        "$(mk 'nc smtp.example.com 25 < m.txt')" ask
expect "ncat host 587"                                     "$(mk 'ncat --ssl smtp.example.com 587')" ask
expect "socat TCP:host:465"                                "$(mk 'socat - TCP:smtp.example.com:465')" ask
expect "telnet host 25"                                    "$(mk 'telnet smtp.example.com 25')" ask

echo "must ALLOW (exit 0, no output)"
expect "send.sh --dry-run"                                 "$(mk "bash $SEND --dry-run $EML")" allow
expect "\"\$S/send.sh\" --dry-run"                         "$(mk 'S=/x; bash "$S/send.sh" --dry-run m.eml')" allow
expect "send.sh m.eml --dry-run (flag after the file)"     "$(mk 'bash send.sh m.eml --dry-run')" allow
expect "egress-check.sh"                                   "$(mk 'bash "${CLAUDE_PLUGIN_ROOT}/scripts/egress-check.sh"')" allow
expect "doctor.sh"                                         "$(mk 'bash "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.sh"')" allow
expect "new-eml.sh"                                        "$(mk 'bash new-eml.sh --to bob@example.net --subject x --body-file b.txt')" allow
expect "header-check.sh --headers file"                    "$(mk 'bash header-check.sh --headers h.txt')" allow
expect "header-check.sh --direct-v4 IP --headers file"     "$(mk 'bash header-check.sh --direct-v4 198.51.100.7 --headers h.txt')" allow
expect "header-check.sh --dry-run"                         "$(mk 'bash "${CLAUDE_PLUGIN_ROOT}/scripts/header-check.sh" --dry-run')" allow
expect "command -v msmtp"                                  "$(mk 'command -v msmtp')" allow
expect "command -V sendmail"                               "$(mk 'command -V sendmail')" allow
expect "which msmtp; type msmtp"                           "$(mk 'which msmtp; type msmtp')" allow
expect "msmtp --version"                                   "$(mk 'msmtp --version')" allow
expect "msmtp --serverinfo"                                "$(mk 'msmtp --serverinfo -a work')" allow
expect "grep PATTERN naming msmtp/sendmail/smtplib"        "$(mk "grep -n 'msmtp\\|sendmail\\|smtplib.SMTP(' notes.md")" allow
expect "printf body naming msmtp -t"                       "$(mk "printf 'run msmtp -t < m.eml\\n' > notes.txt")" allow
expect "echo naming sendmail and swaks"                    "$(mk 'echo "use sendmail or swaks"; echo curl smtps://x')" allow
expect "cat heredoc writing an smtplib script"             "$(mk $'cat > s.py <<EOF\nimport smtplib\nsmtplib.SMTP("smtp.example.com")\nEOF')" allow
expect "cat <<EOF | bash with no mail tool"                "$(mk $'cat <<EOF | bash\necho hello\nEOF')" allow
expect "python3 -c without smtplib"                        "$(mk "python3 -c 'import json; print(1)'")" allow
expect "python3 importing smtplib, no SMTP("               "$(mk "python3 -c 'import smtplib; print(smtplib.__file__)'")" allow
expect "curl https://"                                     "$(mk 'curl -fsS https://www.example.com/')" allow
expect "openssl s_client to :443"                          "$(mk 'openssl s_client -connect www.example.com:443')" allow
expect "nc -z host 443; telnet host 80"                    "$(mk 'nc -z www.example.com 443; telnet www.example.com 80')" allow
expect "mail -f reads a mailbox; bare mutt"                "$(mk 'mail -f ~/mbox; mutt')" allow
expect "cat / shellcheck / bash -n on send.sh"             "$(mk "cat $SEND; shellcheck $SEND; bash -n $SEND")" allow
expect "5000-deep \$( with no mail tool"                   "$(mk "$DEEP_LS")" allow
expect "ordinary bash"                                     "$(mk 'ls -la ~/Documents')" allow

echo "SKILL.md command lines, read from the file (verdict from each line's comment)"
SKILL="$ROOT/skills/smtp-egress/SKILL.md"
n=0
while IFS= read -r line; do
  n=$((n+1))
  want=allow; case "$line" in *"# ASKS"*) want=ask ;; esac
  expect "SKILL: ${line:0:52}" "$(mk "$line")" "$want"
done < <(grep -E '^bash "\$\{CLAUDE_PLUGIN_ROOT\}/scripts/' "$SKILL")
if [ "$n" -ge 7 ]; then printf '  ok    %-58s %s\n' "SKILL.md lines found" "$n"; pass=$((pass+1))
else printf '  FAIL  %-58s %s\n' "SKILL.md lines found (want >= 7)" "$n"; fail=$((fail+1)); fi

echo "must NEVER THROW (exit 0, no output)"
expect "empty stdin"        '' allow
expect "malformed json"     '{not json' allow
expect "no tool_input"      '{"tool_name":"Bash"}' allow
expect "null tool_input"    '{"tool_name":"Bash","tool_input":null}' allow
expect "unrelated tool"     '{"tool_name":"Read","tool_input":{"file_path":"/tmp/x"}}' allow

echo "reason carries the facts, verdict first"
contains "verdict first"                    "$(mk "bash $SEND $EML")" "smtp-egress: send a REAL email?"
contains "readable .eml: To"                "$(mk "bash $SEND $EML")" "To: bob@example.net"
contains "readable .eml: Subject"           "$(mk "bash $SEND $EML")" "Subject: Quarterly notes"
contains "readable .eml: sha256[:12]"       "$(mk "bash $SEND $EML")" "sha256: $SHA12"
contains "egress runs after approval"       "$(mk "bash $SEND $EML")" "egress-check runs after approval"
contains "unreadable .eml says unread"      "$(mk 'bash "${CLAUDE_PLUGIN_ROOT}/scripts/send.sh" /nonexistent/x.eml')" "unread"
contains "bypass names send.sh"             "$(mk 'sendmail -t < m.eml')" "send.sh"
NOMID="$TMP/nomid.eml"
printf 'From: alice@example.com\nTo: bob@example.net\nSubject: x\nDate: Thu, 12 Nov 2026 10:00:00 +0000\n\nx\n' >"$NOMID"
contains "no Message-ID is flagged"         "$(mk "bash $SEND $NOMID")" "no Message-ID yet"
MULTI="$TMP/multi.eml"
printf 'From: alice@example.com\nTo: Bob <bob@example.net>, carol@example.net\nCc: dave@example.org\nBcc: erin@example.com\nSubject: x\nDate: Thu, 12 Nov 2026 10:00:00 +0000\nMessage-ID: <m@example.com>\n\nx\n' >"$MULTI"
contains "lists To recipients"              "$(mk "bash $SEND $MULTI")" "To: bob@example.net, carol@example.net"
contains "lists Cc"                         "$(mk "bash $SEND $MULTI")" "Cc: dave@example.org"
contains "lists Bcc"                        "$(mk "bash $SEND $MULTI")" "Bcc: erin@example.com"
MANY="$TMP/many.eml"
{ printf 'From: alice@example.com\nTo: '
  for k in $(seq 1 40); do printf 'user%02d@example.net, ' "$k"; done
  printf 'last@example.net\nSubject: %s\nDate: Thu, 12 Nov 2026 10:00:00 +0000\nMessage-ID: <n@example.com>\n\nx\n' "$(printf 'S%.0s' $(seq 1 200))"; } >"$MANY"
contains "many recipients → +N more"        "$(mk "bash $SEND $MANY")" "more)"
r=$(reason "$(mk "bash $SEND $MANY")")
# ~300 for recipients + 80 for the Subject + the fixed text around them.
if [ "${#r}" -le 560 ]; then printf '  ok    %-58s %s chars\n' "capped reason length" "${#r}"; pass=$((pass+1))
else printf '  FAIL  %-58s %s chars\n' "capped reason length" "${#r}"; fail=$((fail+1)); fi
contains "long Subject is capped"           "$(mk "bash $SEND $MANY")" "SSS..."

echo "reason is ONE line"
one_line "send.sh"   "$(mk "bash $SEND $EML")"
one_line "msmtp"     "$(mk 'msmtp -t < m.eml')"
one_line "unsure"    "$(mk "$DEEP_MAIL")"

echo
echo "passed ${pass}, failed ${fail}"
[ "$fail" -eq 0 ]
