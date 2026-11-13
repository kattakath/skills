#!/usr/bin/env bash
# Stub himalaya for inbox-cases.sh and send-cases.sh. Never opens a socket.
#   - appends its argv (one call per line, words joined by US 0x1f) to $STUB_DIR/him.argv
#   - copies the -c config to $STUB_DIR/him.conf and its octal mode to $STUB_DIR/him.mode
#   - answers like himalaya 2.2.1 --json; mail content carries an ANSI escape on purpose
#   - for header-check: `envelope search … subject <token>` finds the probe .eml whose
#     name holds <token> in $XDG_STATE_HOME/smtp-egress/ and returns its Message-ID, and
#     `message read --raw` returns Gmail-shaped headers for it ($STUB_HOP is the first hop)
#   - exits $STUB_HIM_RC (default 0)
set -u
d="${STUB_DIR:?}"
( IFS=$'\x1f'; printf '%s\n' "$*" ) >>"$d/him.argv"
cfg=""; prev=""
for a in "$@"; do [ "$prev" = "-c" ] && cfg="$a"; prev="$a"; done
if [ -n "$cfg" ] && [ -f "$cfg" ]; then
  cp "$cfg" "$d/him.conf"
  python3 -I -c 'import os,sys; print(format(os.stat(sys.argv[1]).st_mode & 0o777, "o"))' "$cfg" >"$d/him.mode"
fi
rc="${STUB_HIM_RC:-0}"
words=" $* "
state="${XDG_STATE_HOME:-$HOME/.local/state}/smtp-egress"
case "$words" in
  " --version ") echo "himalaya v2.2.1 (stub)" ;;
  *" mailbox list "*)
    printf '{"mailboxes":[{"id":"INBOX","name":"INBOX","role":"inbox"},{"id":"[Gmail]/Spam","name":"[Gmail]/Spam","role":null}]}\n' ;;
  *" envelope search "* | *" envelope list "*)
    token="${!#}"; mid=""
    for f in "$state"/probe-*"$token"*.eml; do
      [ -f "$f" ] && mid=$(sed -n 's/^Message-ID: <\(.*\)>\r*$/\1/p' "$f" | head -1)
    done
    if [ -n "$mid" ]; then
      printf '{"envelopes":[{"id":"77","message-id":"%s","subject":"smtp-egress header probe %s","from":[{"name":null,"email":"alice@example.com"}],"date":"2026-11-13T10:00:00Z"}]}\n' "$mid" "$token"
    else
      printf '{"queued":0,"envelopes":[{"id":"12","message-id":"m1@example.net","subject":"Hello \\u001b[31mthere\\u001b[0m","from":[{"name":"Bob","email":"bob@example.net"}],"date":"2026-11-12T10:00:00Z"}]}\n'
    fi ;;
  *" message read "*)
    if [[ "$words" == *" --raw 77 "* ]]; then
      mid=$(sed -n 's/^Message-ID: <\(.*\)>\r*$/\1/p' "$state"/probe-*.eml 2>/dev/null | tail -1)
      printf 'Received: from mail.example.com (mail.example.com. [2001:db8:ff::2])\r\n        by mx.example.net with ESMTPS id y; Thu, 13 Nov 2026 10:00:01 -0800\r\n'
      printf 'ARC-Authentication-Results: i=1; mx.example.net; dkim=pass header.i=@example.com; spf=pass; dmarc=pass (p=NONE) header.from=example.com\r\n'
      printf 'DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=s1; b=AAAA\r\n'
      printf 'Received: from [2001:db8:ffff::5] (host.example [%s])\r\n        by smtp.gmail.com with ESMTPSA id z; Thu, 13 Nov 2026 10:00:00 -0800\r\n' "${STUB_HOP:-203.0.113.9}"
      printf 'From: alice@example.com\r\nTo: probe@example.net\r\nMessage-ID: <%s>\r\nSubject: probe\r\n\r\nbody\r\n' "$mid"
    else
      printf 'From: Bob <bob@example.net>\nSubject: Hello\n\nbody \033]0;evil-title\007text\n'
    fi ;;
esac
exit "$rc"
