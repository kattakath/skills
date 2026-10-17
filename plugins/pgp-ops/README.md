# pgp-ops

GnuPG from an agent session: **decrypt to the clipboard, never to the transcript**; encrypt to
someone else's key without importing it; and **prove** every answer about a message or a key from
its packets instead of assuming it.

## The two facts this plugin exists to carry

**1. An agent's shell has no TTY, so a curses pinentry cannot ask for the passphrase.** The fix is a
real terminal window running one decrypt (`scripts/gpg-in-window.zsh`). It has two measured traps:
a fresh window's pty is **0×0** when the command starts, so pinentry dies with "Screen or window
too small" unless you wait for `stty size`; and the terminal's own `TERM` may be unknown to the
pinentry's ncurses. The script handles both and writes a status file that carries lengths and flags,
never plaintext.

**2. "Who can read this?" is a packet question.** A public key cannot decrypt anything. Whether the
holder of key K can read message M is whether M carries a session key for K's *encryption
subkey* — `gpg --list-packets` answers it with no passphrase. "Same key?" is `--dearmor` + `cmp`
plus fingerprints. "What does this decrypt to?", for a message you produced for someone else, is a
`cmp` against your saved ciphertext, because you cannot decrypt it.

## Also inside

| Topic | Why it is there |
|---|---|
| Concealed, auto-clearing clipboard | Decrypted text goes through `pb-conceal` when present: clipboard managers do not record it, Universal Clipboard does not sync it, and it clears after `$PGP_CLEAR` s. Plain `pbcopy` would put it in Maccy-style history on disk |
| GUI pinentry first | With a GUI pinentry (pinentry-mac, Save-in-Keychain disabled) everything runs in the agent's own shell; the terminal-window route remains for curses-only setups |
| Plaintext guard (PreToolUse hook) | Decrypted text reaches the clipboard ONLY: the hook refuses `gpg -d` and a command-less `gpg` in the agent's shell, any clipboard read that is not a count or digest, and computer-use `read_clipboard`. 68 cases in `tests/guard-cases.sh` |
| Clipboard in, clipboard out | Decrypt the message already on the clipboard (`-`), or `encrypt-for`: clipboard plaintext → message to the recipient **and** you, with no passphrase and no window; your own key's presence among the recipients is checked before the clipboard is replaced. `sign` opts into a signature |
| Signing ≠ readable later | Reading your own sent copy needs you as a second recipient; a signature only proves authorship |
| One-line armor repair | Chat boxes strip newlines; gpg then says "no valid OpenPGP data found" |
| Key generation choices | A PGP key built from an SSH key is linkable to the user's forge account even with no user ID |
| Backups | Single-line base64 (the macOS Keychain returns multi-line values as hex), stored unexported, verified by hash, restore-tested with `--show-keys` (writes nothing) |
| Fleet adapter | The kattakath fleet's `set-secret` / `secrets-push` lane, and the gcloud identity trap |

## Requires

`gpg` (GnuPG 2.x), `pbcopy`/`pbpaste` (macOS), and a terminal that can open a window running a
command (measured with Ghostty 1.3; Terminal.app is the untested alternative).
