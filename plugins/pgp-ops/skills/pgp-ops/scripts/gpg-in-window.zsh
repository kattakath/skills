#!/bin/zsh
# gpg-in-window.zsh — run ONE GnuPG operation inside a real terminal window, so a
# curses/tty pinentry can draw there, with the macOS clipboard as input and output.
# For agents whose own shell has no TTY. Launch, e.g.:
#
#   open -na Ghostty.app --args -e /bin/zsh gpg-in-window.zsh <mode> <args…>
#
# Decrypt — ciphertext from a file, or "-" for the clipboard (then <prefix> is required):
#   gpg-in-window.zsh all|first-word|before-space <message.asc | -> [<prefix>]
#     all           the whole plaintext, byte-exact
#     first-word    everything before the first whitespace (space, tab, newline)
#     before-space  everything before the first literal SPACE character
#
# Encrypt — plaintext FROM the clipboard, ciphertext back TO the clipboard:
#   gpg-in-window.zsh encrypt-for <recipient-key.asc> <prefix>
#     Signs with your secret key and encrypts to the recipient AND to you, so you
#     can still read what you sent. Your key: $PGP_SELF (fingerprint), else the
#     only secret key in the keyring. The recipient key is used without importing.
#     Self-check before the clipboard is touched: your key decrypts the result back
#     to the same bytes (compared by sha256), with a good signature.
#
# Files written, both plaintext-free by construction:
#   <prefix>.status  one line: OK/FAILED, mode, lengths, flags, recipient key ids
#   <prefix>.diag    tty, terminal size, and gpg's own stderr (key ids, signatures)
#
# Plaintext lives only in this shell's memory or in a pipe to/from the clipboard.
# Trade-off, accepted: in `all` mode a FAILED decrypt still runs pbcopy, so the
# clipboard is emptied rather than left holding its previous content.
set -o pipefail
mode=$1
case $mode in
  encrypt-for) keyfile=$2 prefix=$3 ;;
  *) msg=$2 prefix=${3:-$2} ;;
esac
if [[ -z $prefix || $prefix == - ]]; then
  print -u2 "gpg-in-window: a <prefix> for the status files is required with '-' and encrypt-for"
  exit 64
fi
st="$prefix.status" diag="$prefix.diag"
rm -f "$st" "$diag"
export GPG_TTY=$(tty)

# A freshly opened window's pty is 0x0 until the terminal lays it out, and
# pinentry-curses then fails with "Screen or window too small". Wait (<=5 s).
for i in {1..50}; do s=$(stty size 2>/dev/null); [[ ${s%% *} -ge 10 ]] && break; sleep 0.1; done
# The pinentry's ncurses may lack a terminfo entry for the terminal's own TERM.
export TERM=xterm-256color
printf 'tty=%s size=%s\n' "$GPG_TTY" "$s" > "$diag"

res=1
report() { printf '%s\n' "$1" | tee "$st"; [[ $1 == OK* ]] && res=0; }
# Recipient key ids of an armored message on stdin. An EMPTY homedir holds no secret
# key, so gpg can only list the session-key packets — it never tries to decrypt.
recipients() {
  local h; h=$(mktemp -d "${TMPDIR:-/tmp}/rcpt.XXXX")
  gpg --homedir "$h" --batch --list-packets 2>/dev/null | grep -oE 'keyid [0-9A-F]+' | cut -d' ' -f2 | sort -u | paste -sd, -
  gpgconf --homedir "$h" --kill all 2>/dev/null
  rm -rf "$h"
}
# Ciphertext for the decrypt modes, read ONCE into memory before anything writes the
# clipboard: `pbpaste | gpg -d | pbcopy` reads and writes the same clipboard in one
# pipeline, and a writer that clears it first races the reader (measured with a
# file-backed stand-in, 2026-10-17).
# Only the clipboard case is buffered: a shell variable cannot hold NUL bytes, so a
# binary .gpg FILE is streamed straight to gpg instead.
[[ $mode != encrypt-for && $msg == - ]] && ct_in=$(pbpaste)
ciphertext() { if [[ $msg == - ]]; then printf '%s\n' "$ct_in"; else cat -- "$msg"; fi; }

case $mode in
  all)
    if ciphertext | gpg -d 2> >(tee -a "$diag" >&2) | pbcopy; then
      report "OK mode=all bytes=$(pbpaste | wc -c | tr -d ' ') nested-pgp=$(pbpaste | grep -c 'BEGIN PGP')"
    else
      report "FAILED mode=all exit=$?"
    fi
    ;;
  first-word | before-space)
    if pt=$(ciphertext | gpg -d 2> >(tee -a "$diag" >&2)); then
      if [[ $mode == first-word ]]; then
        out=$(printf '%s\n' "$pt" | grep -oE '[^[:space:]]+' | head -n 1)
      else
        out=${pt%% *}
      fi
      printf '%s' "$out" | pbcopy
      report "OK mode=$mode chars=${#out} nested-pgp=$(printf '%s\n' "$pt" | grep -c 'BEGIN PGP')"
    else
      report "FAILED mode=$mode exit=$?"
    fi
    unset pt out
    ;;
  encrypt-for)
    self=${PGP_SELF:-}
    if [[ -z $self ]]; then
      fprs=(${(f)"$(gpg --with-colons --list-secret-keys 2>/dev/null | awk -F: '$1=="sec"{f=1;next} f&&$1=="fpr"{print $10;f=0}')"})
      if (( ${#fprs} == 1 )); then self=$fprs[1]; else self=""; fi
    fi
    if [[ -z $self ]]; then
      report "FAILED mode=encrypt-for reason=set-PGP_SELF (secret keys found: ${#fprs})"
    elif [[ ! -s $keyfile ]]; then
      report "FAILED mode=encrypt-for reason=no-recipient-key-file"
    else
      h_in=$(pbpaste | shasum -a 256 | cut -d' ' -f1)
      if ct=$(pbpaste | gpg --armor --sign --local-user "$self" --encrypt \
          --recipient-file "$keyfile" --recipient "$self" 2> >(tee -a "$diag" >&2)); then
        # Self-check BEFORE replacing the clipboard: the passphrase is cached now.
        h_out=$(printf '%s\n' "$ct" | gpg -d 2>"$prefix.verify" | shasum -a 256 | cut -d' ' -f1)
        good=$(grep -c 'Good signature' "$prefix.verify")
        cat "$prefix.verify" >> "$diag"; rm -f "$prefix.verify"
        rcpts=$(printf '%s\n' "$ct" | recipients)
        if [[ $h_in == "$h_out" && $good -ge 1 ]]; then
          printf '%s\n' "$ct" | pbcopy
          report "OK mode=encrypt-for bytes=$(pbpaste | wc -c | tr -d ' ') recipients=$rcpts signed=yes self-roundtrip=identical"
        else
          report "FAILED mode=encrypt-for reason=self-check roundtrip=$([[ $h_in == "$h_out" ]] && echo ok || echo MISMATCH) good-signature=$good (clipboard untouched)"
        fi
      else
        report "FAILED mode=encrypt-for exit=$? (clipboard untouched)"
      fi
      unset ct h_in h_out
    fi
    ;;
  *)
    report "USAGE: gpg-in-window.zsh all|first-word|before-space <msg.asc|-> [prefix] | encrypt-for <key.asc> <prefix>"
    ;;
esac

unset ct_in
printf '\nDone. Press any key to close this window.\n'
read -k1 -s || true
exit $res
