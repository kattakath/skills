#!/usr/bin/env bash
# Cases for scripts/plaintext-guard.js.
#
# A guard that cannot be shown to refuse the leaks AND to stay quiet on the work the
# skill itself documents is decoration. Four things are asserted:
#   1. every route by which decrypted text could reach the model is BLOCKED
#   2. every command the skill tells the agent to run is ALLOWED (false positives
#      would push the agent toward an unguarded workaround)
#   3. the guard only inspects the tools it is registered for
#   4. it FAILS OPEN on a malformed payload — it must never strand a session
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
GUARD="$here/../scripts/plaintext-guard.js"
[ -f "$GUARD" ] || { echo "FAIL: guard not found at $GUARD"; exit 1; }
fail=0

run() { # <tool> <command>
  python3 -c '
import json,sys
t, c = sys.argv[1], sys.argv[2]
key = "input" if t.endswith("interact_with_process") else "command"
print(json.dumps({"tool_name": t, "tool_input": {key: c}}))
' "$1" "$2" | node "$GUARD"
}
want() { # <block|approve> <tool> <command>
  got=$(run "$2" "$3")
  if printf '%s' "$got" | grep -q "\"decision\":\"$1\""; then
    printf 'ok   %-7s %s\n' "$1" "$3"
  else
    printf 'FAIL want %s, got: %s   <- %s\n' "$1" "$got" "$3"; fail=1
  fi
}
B() { want block Bash "$1"; }
A() { want approve Bash "$1"; }

echo "-- 1. decrypt in the agent's shell"
B 'gpg -d m.asc'
B 'gpg --decrypt m.asc'
B 'gpg --batch --pinentry-mode error -d m.asc'
B 'gpg --homedir "$h" --batch -d m.asc'
B 'cat m.asc | gpg -d'
B 'gpg --output out.txt --decrypt m.asc'
B 'gpg --decrypt-files a.asc b.asc'
B 'gpg -qd m.asc'
B 'sudo gpg -d m.asc'
B 'gpg2 --decrypt m.asc'
B '/opt/homebrew/bin/gpg -d m.asc'
B 'gpgtar --decrypt bundle.gpg'
B "sh -c 'gpg -d m.asc'"
B 'x=$(gpg -d m.asc); echo "$x"'
B 'gpg m.asc'
B 'gpg -o out.txt m.asc'

echo "-- 1b. clipboard reads that reach the model"
B 'pbpaste'
B 'pbpaste > out.txt'
B 'pbpaste | head -1'
B 'pbpaste | grep -c foo'
B 'pbpaste | base64'
B 'pbpaste | cat'
B 'x=$(pbpaste); echo "$x"'
B 'printf "%s" "$(pbpaste)" | wc -c'
B 'pbpaste | gpg -d'
B 'pbpaste | gpg --enarmor'
B 'pbpaste | gpg --clearsign'
B 'pbpaste | gpg --store'
B 'pbpaste | openssl base64'
B 'pbpaste | secret reveal x'
B 'pbpaste | secret copy x'
B "pbpaste | secret exec V=x -- sh -c 'cat'"
B 'pbpaste | secret'
B "pbpaste | tr -d '\n' | secret set x"
B "osascript -e 'the clipboard'"
B "osascript -e 'get the clipboard as text'"
B 'python3 -c "import pyperclip; print(pyperclip.paste())"'
B 'wl-paste'
B 'xclip -selection clipboard -o'
want block mcp__computer-use__read_clipboard ''
want block mcp__plugin_desktop-commander_desktop-commander__start_process 'gpg -d m.asc'
want block mcp__plugin_desktop-commander_desktop-commander__interact_with_process 'pbpaste'

echo "-- 2. what the skill tells the agent to run"
A 'open -na Ghostty.app --args -e /bin/zsh scripts/gpg-in-window.zsh all - "$PWD/run1"'
A 'zsh scripts/gpg-in-window.zsh encrypt-for "$PWD/THEIRS.asc" "$PWD/run2"'
A 'gpg --homedir "$(mktemp -d)" --batch --list-packets OUT.asc'
A 'gpg --batch --pinentry-mode error --list-packets M.asc </dev/null'
A 'gpg --show-keys --with-colons --with-subkey-fingerprints K.asc'
A 'gpg --batch --yes --armor --encrypt --recipient-file THEIRS.asc --output OUT.asc IN.txt'
A 'gpg -ear alice@example.invalid -o out.asc in.txt'
A 'gpg --list-secret-keys --with-colons'
A 'gpg -K'
A 'gpg --export-ssh-key "FPR!"'
A 'gpg --dearmor < k.asc | cmp - other.gpg'
A 'gpg --verify signed.asc'
A 'gpg --quick-generate-key "uid" ed25519 sign,cert 2y'
A 'gpg --export-secret-keys FPR | base64 | tr -d "\n"'
A "secret exec V=pgp:x:secret-key -- sh -c 'printf %s \"\$V\" | base64 -d | gpg --batch --show-keys --with-colons'"
A 'pbpaste | wc -c'
A 'pbpaste | shasum -a 256 | cut -c1-16'
A 'pbpaste | openssl dgst -sha256'
A 'pbpaste | gpg --batch --list-packets'
A 'pbpaste | gpg --armor --encrypt --recipient-file THEIRS.asc | pbcopy'
A 'pbpaste | gpg --dearmor > key.gpg'
A 'pbpaste | secret set --no-export android-emu:pixel_play:pin'
A 'pbpaste | set-secret x'
A 'printf "x" | pbcopy'
A "osascript -e 'set the clipboard to \"x\"'"
A 'gpgconf --kill all'
A 'gpg-connect-agent updatestartuptty /bye'
A 'gpgconf --list-dirs agent-ssh-socket'
A 'git log --oneline -3'
A 'echo hello'

echo "-- 3. only its own tools"
want approve Read ''
want approve mcp__plugin_desktop-commander_desktop-commander__read_file ''

echo "-- 4. fails open"
got=$(printf 'not json' | node "$GUARD")
if printf '%s' "$got" | grep -q '"decision":"approve"'; then echo "ok   approve malformed payload"; else echo "FAIL malformed payload -> $got"; fail=1; fi

exit $fail
