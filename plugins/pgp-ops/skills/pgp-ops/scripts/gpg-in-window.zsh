#!/bin/zsh
# gpg-in-window.zsh — run ONE GnuPG decrypt inside a real terminal window, so a
# curses/tty pinentry can draw there, and put the result (or part of it) on the
# macOS clipboard. For agents whose own shell has no TTY. Launch, e.g.:
#
#   open -na Ghostty.app --args -e /bin/zsh gpg-in-window.zsh <mode> <message.asc>
#
# Modes:
#   all           the whole plaintext, byte-exact (gpg -d | pbcopy)
#   first-word    everything before the first whitespace (space, tab, newline)
#   before-space  everything before the first literal SPACE character
#
# Files written next to <message.asc>, both plaintext-free by construction:
#   .status  one line: OK/FAILED, mode, lengths, nested-pgp count
#   .diag    tty, terminal size, and gpg's own stderr (recipient key ids and any
#            signature lines — what the agent needs to report signed/unsigned)
#
# The plaintext lives only in this shell's memory or in the pipe to pbcopy.
# Trade-off, accepted: in `all` mode a FAILED decrypt still runs pbcopy, so the
# clipboard is emptied rather than left holding its previous content.
set -o pipefail
mode=$1 msg=$2
st="$msg.status" diag="$msg.diag"
rm -f "$st" "$diag"
export GPG_TTY=$(tty)

# A freshly opened window's pty is 0x0 until the terminal lays it out, and
# pinentry-curses then fails with "Screen or window too small". Wait (<=5 s).
for i in {1..50}; do s=$(stty size 2>/dev/null); [[ ${s%% *} -ge 10 ]] && break; sleep 0.1; done
# The pinentry's ncurses may lack a terminfo entry for the terminal's own TERM.
export TERM=xterm-256color
printf 'tty=%s size=%s\n' "$GPG_TTY" "$s" > "$diag"

report() { printf '%s\n' "$1" | tee "$st"; }

case $mode in
  all)
    if gpg -d "$msg" 2> >(tee -a "$diag" >&2) | pbcopy; then
      report "OK mode=all bytes=$(pbpaste | wc -c | tr -d ' ') nested-pgp=$(pbpaste | grep -c 'BEGIN PGP')"
    else
      report "FAILED mode=all exit=$?"
    fi
    ;;
  first-word | before-space)
    if pt=$(gpg -d "$msg" 2> >(tee -a "$diag" >&2)); then
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
  *)
    report "USAGE: gpg-in-window.zsh all|first-word|before-space <message.asc>"
    ;;
esac

printf '\nDone. Press any key to close this window.\n'
read -k1 -s
