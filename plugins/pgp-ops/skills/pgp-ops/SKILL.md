---
name: pgp-ops
description: This skill should be used when the user pastes a "-----BEGIN PGP MESSAGE-----" or "-----BEGIN PGP PUBLIC KEY BLOCK-----", or asks to "decrypt this with my key and pipe it to clipboard", "decrypt the PGP message on my clipboard", "pipe the first word / the part before the first space to my clipboard", "encrypt this address with this public key", "encrypt with the recipient's key and sign it with mine so I can read it later", "is it the same public key", "can this be decrypted by whoever has this key", "what does this message decrypt to", "generate a PGP key from my SSH key", or "back up my PGP key". Runs GnuPG from an agent that has no TTY — passphrase prompts go to a real terminal window, plaintext goes to the clipboard and never into the transcript, and every "who can read it / is it the same / does it round-trip" answer is proved from the packets, not assumed.
---

# PGP ops — GnuPG from an agent: no TTY, no plaintext in the transcript

**What and when.** Encrypt, decrypt, compare and back up OpenPGP material on the user's behalf,
when the agent's own shell cannot show a passphrase prompt and the plaintext must not land in the
conversation. Everything is plain `gpg` plus `pbcopy`; the only non-obvious parts are where the
passphrase prompt can draw, and how to *prove* each answer.

## Ground rules

- **Plaintext goes to the clipboard, never the transcript.** Print it only when the user says
  "print" or "show". Report metadata instead: bytes, lines, signed or unsigned, nested or not.
- **Plaintext never touches disk.** Hold it in shell memory (`pt=$(gpg -d …)`) or pipe it straight
  into `pbcopy`. Ciphertext and public keys may be saved as files; they are what you compare.
- **A public key cannot decrypt anything.** "Can the holders of key K read message M?" means
  "does M carry a public-key-encrypted session key for K's *encryption subkey*?" Answer it from M's
  packets (§ 1).
- **Every message encrypted for someone else is signed by the user AND encrypted to the user too**
  (`encrypt-for`, § 4), so the user can always decrypt what they sent. Never silently produce a
  copy only the recipient can read. Encrypting to the user's key alone means only the user can read it.
- **Never ask for the passphrase in chat.** It goes into pinentry, typed by the human.

## 1. Inspect first — none of this needs a passphrase

| Question | Instrument |
|---|---|
| Who can decrypt M? | `gpg --batch --pinentry-mode error --list-packets M.asc </dev/null 2>/dev/null \| grep -oE 'keyid [0-9A-F]+'` — one line per recipient |
| What is in key file K? | `gpg --show-keys --with-colons --with-subkey-fingerprints K.asc` — reads without importing; `sub:…:e` is the encryption subkey whose 16-hex tail is the keyid above |
| Is it mine? | `gpg --batch --pinentry-mode error -d M.asc` → `No secret key` (not yours) vs `No pinentry` (yours; passphrase needed, § 2) |
| Same public key? | Two instruments that could disagree: `gpg --dearmor` both and `cmp`, **and** compare fingerprints from `--show-keys`. Different armor text can be the same key |
| What does M decrypt to, when M is encrypted to someone else? | You cannot decrypt it. If you produced it, `cmp` it against your saved ciphertext — a byte match proves the content without opening it. Say that is the evidence |

`--list-packets` on an encrypted message also *tries* to decrypt; `--pinentry-mode error` and
`</dev/null` keep it from hanging, and it exits non-zero — grep the keyid lines and ignore the
exit status.

**Armor pasted as one line** (a chat box or form collapsed the newlines) fails with
`gpg: no valid OpenPGP data found`. Rebuild it rather than guess: strip the BEGIN/END markers,
split off the trailing `=XXXX` CRC, `fold -w 64` the body, and put a blank line after the header.
Then compare bytes as above. Tell the user the copy they are sharing is broken the same way for
the recipient — send a `.asc` file instead.

## 2. The passphrase prompt — when the agent has no TTY

The agent's shell has no terminal, so a curses or tty pinentry fails with
`Inappropriate ioctl for device` or `No pinentry`. In order:

1. **Is a GUI pinentry configured?** `gpgconf --list-options gpg-agent | grep pinentry-program`,
   and look at what the default `pinentry` resolves to. If it is a GUI one (pinentry-mac, gnome3,
   qt), plain `gpg -d` from the agent works and the rest of this section is skipped.
2. **Is the passphrase still cached?** `gpg --batch --pinentry-mode error -d M.asc` succeeds inside
   the agent's `default-cache-ttl` (600 s by default) after the human last typed it.
3. **Otherwise, run the operation in a real terminal window** with
   [`scripts/gpg-in-window.zsh`](scripts/gpg-in-window.zsh):
   ```bash
   W='open -na Ghostty.app --args -e /bin/zsh scripts/gpg-in-window.zsh'
   $W first-word "$PWD/M.asc"          # decrypt a saved message
   $W all - "$PWD/run1"                # decrypt the message ON THE CLIPBOARD
   $W encrypt-for "$PWD/THEIRS.asc" "$PWD/run2"   # § 4: clipboard plaintext → signed ciphertext
   ```
   It writes `<prefix>.status` (lengths, flags, recipient keyids) and `<prefix>.diag` (gpg's
   stderr), never plaintext; the prefix defaults to the message path and is required with `-` and
   `encrypt-for`. The script exits 0 on OK, 1 on FAILED. Wait for the status file with a
   backgrounded `until [ -s <prefix>.status ]` loop, then read both. Terminal.app via `osascript … do script` is the
   untested alternative; the two traps below are what carries over.

**Two traps, measured with Ghostty 1.3 and pinentry-curses 1.3.3 (2026-10):**
- A freshly opened window's pty is **0×0** when the command starts, so pinentry fails at once with
  `Screen or window too small`. The script waits until `stty size` reports ≥ 10 rows.
- The terminal's own `TERM` (e.g. `xterm-ghostty`) may have no terminfo entry in the pinentry's
  ncurses. The script exports `TERM=xterm-256color`.

An in-app terminal panel is the other option, but one measured host caps a session at **6 tabs**
and refuses to close a tab the human has typed in — and typing a passphrase counts. Six decrypts
filled it. The window route has no such cap.

## 3. Decrypt — report without revealing

- **Input** is a saved file, or `-` for the message already on the clipboard. The clipboard case is
  read into memory **before** anything writes the clipboard: `pbpaste | gpg -d | pbcopy` reads and
  writes one clipboard in one pipeline, and a writer that clears it first races the reader.
- **`all`** pipes `gpg -d` into `pbcopy` under `pipefail`: byte-exact, and a failure empties the
  clipboard (documented trade-off in the script).
- **`first-word`** stops at any whitespace; **`before-space`** stops at the first literal space, so
  a first line ending in a newline is included. Use the one the user's words name.
- **Check the clipboard independently** of the script's own report: `pbpaste | wc -c`, and
  `pbpaste | grep -q '[[:space:]]'` for "one word". Never `pbpaste` to the transcript.
- **Nested armor:** if the plaintext is itself `-----BEGIN PGP MESSAGE-----`, the user received a
  second layer, often addressed to someone else. Run § 1 on the inner message and say whose it is.
- **Signed or not:** read `.diag`. No `Good signature` / `Signature made` line means unsigned, so the
  sender is not proven, even though it was encrypted to the user.

## 4. Encrypt for someone

**Signing does not let you read it later — encrypting to yourself does.** A signature proves the
message came from you; only a session key for *your* encryption subkey lets you decrypt your own
sent copy. When the user wants both, that is two recipients plus `--sign`. Correct the user if
they conflate the two.

**The default, always: `encrypt-for`** (§ 2.3) — signed, to them and to the user. Put the plaintext on the clipboard (the user copies it, or
`pbcopy` from what they typed), save the recipient's public key as `THEIRS.asc`, run it. It signs
with the user's key (`$PGP_SELF`, else the only secret key), encrypts to them **and** to the user,
self-checks that the user's key decrypts it back to the same bytes with a `Good signature`, and
only then replaces the clipboard with the armored message. On any failure the clipboard is left
holding the plaintext, untouched.

**Unsigned, to them only — ONLY when the user explicitly asks for it** (e.g. the message must not
be attributable to them). It needs no passphrase and runs in the agent's own shell, which makes it
tempting as a shortcut; it is not one, because the user can never read that copy again. Say so
before using it.
```bash
gpg --batch --yes --armor --encrypt --recipient-file THEIRS.asc --output OUT.asc IN.txt
```
- `--recipient-file` uses the key **without importing it** — no keyring change and no trust prompt.
- **Verify recipients without decrypting:** list the session-key packets against an EMPTY home, which
  holds no key to decrypt with — `gpg --homedir "$(mktemp -d)" --batch --list-packets OUT.asc`
  → one `keyid` per recipient. (`gpg --list-only -d` printed nothing at all here; do not use it.)
- Your own `gpg -d OUT.asc` saying `No secret key` proves you are not a recipient. A round-trip test
  is impossible without their secret key — say so.
- Before the user sends anything, have them **confirm the recipient fingerprint over a second
  channel** (a call, in person). A swapped key means the swapper reads it.
- The clipboard holds one item. Copying a second ciphertext replaces the first, so keep each one as
  a file and re-copy on request.

## 5. Generating a key — decisions for the user, not defaults

Put these to the user as choices (details and recipes in
[`references/key-generation.md`](references/key-generation.md)):

- **From an existing SSH ed25519 key?** Possible, but the PGP public key then **is** the SSH public
  key the user's forge publishes, so it is linkable to them **with no user ID at all**. Also two
  copies of the secret, and a fingerprint that is not reproducible later. A fresh key avoids all
  three.
- **What the user ID says.** It is plaintext to anyone holding the public key. A pseudonym with
  no email is valid OpenPGP. User IDs can be added later but never truly removed from copies already
  out there, so start minimal.
- Default shape: ed25519 sign+certify primary + cv25519 encryption subkey, 2-year expiry
  (extendable). Check the packet is **v4** (`gpg --export FPR | gpg --list-packets | grep -m1 version`)
  for compatibility.

## 6. Back it up — and prove the backup restores

The key lives in `~/.gnupg`, and GnuPG writes the **revocation certificate in the same directory**
(`openpgp-revocs.d/`). One lost disk loses both. For any durable secret store:

1. Export as **one line**: `gpg --export-secret-keys FPR | base64 | tr -d '\n'`. It is still locked by
   the passphrase. One line matters: the macOS Keychain's `security … -w` returns any value
   containing a newline as **hex**. `tr -d '\n'` also undoes GNU `base64`'s wrapping.
2. Store it so it is **never exported into shells**, the revocation certificate likewise. Record the
   sha256 of what you stored.
3. **Read-back by hash**, with the value only in a child process's environment, never printed.
4. **Restore test that writes nothing:** `… | base64 -d | gpg --batch --show-keys --with-colons`
   must show `sec`, `ssb` and the expected fingerprint. `gpg --list-packets` on it should show the
   S2K protection, i.e. still passphrase-locked.
5. Tell the user the one thing no backup holds: **the passphrase.**

## Adapter: the kattakath fleet

| Piece | Value |
|---|---|
| GnuPG | Homebrew `gnupg` + `pinentry` (curses/tty only, deliberately no second GnuPG stack), so § 2.3 applies |
| GUI | GpgFrontend cask; restart it to see keys created from the CLI |
| Store | `set-secret pgp:<uid>:secret-key` from stdin. A `:` in the name fails the env-var grammar, so the item is stored **unbound**; `set-secret` prints "NOT exported" |
| Read-back | `secret exec V=pgp:<uid>:secret-key -- sh -c 'printf %s "$V" \| shasum -a 256'`. Not `secret fp`: its digest is an HMAC under a machine-local salt, so it never equals a sha256 |
| Durable copy | `secrets-push pgp:<uid>:secret-key`, then `secrets-status` must read `in-sync`. Run both with `CLOUDSDK_CONFIG=~/.config/gcloud-nix-config`, because the global gcloud config can hold a client identity |
| Restore | `secrets-resolve <secret-id> \| base64 -d \| gpg --batch --show-keys --with-colons` |

## Pitfalls

- **`secrets-push` exiting 141 with no output** (fixed 2026-10-17): a pre-fix build pushed only the
  last item in the Keychain index; the rest died on SIGPIPE under `pipefail`. Activate a current
  build.
- **A throwaway GNUPGHOME for rehearsal needs a short path.** macOS caps a Unix socket path
  (`sun_path`) at 104 bytes, and an agent scratch directory is longer. Use `mktemp -d "$TMPDIR/g.XXXX"`.
- **The revocation certificate is guarded.** GnuPG puts a `:` before `-----BEGIN`; remove it only
  when actually revoking.
- **Two keys called "the same" may be different text.** Byte-compare after `--dearmor`, then
  fingerprints. Never compare the armored text.

## References

- GnuPG manual, *Unattended key generation* (`Key-Grip:`), `gnupg.info` § 4.5.4.
- keys.openpgp.org, *About*: identity information is only distributed with the owner's consent.
- `Mic92/ssh-to-pgp` `convert.go`: RSA keys only, so no ed25519 conversion route there.
- OpenSSH `PROTOCOL.sshsig`: an SSH signature embeds the public key, so SSH-signed commits publish it too.
