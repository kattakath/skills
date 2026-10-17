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

- **Decrypted text goes to the clipboard ONLY. The AI never prints it and never reads it — not even
  when asked.** Report metadata instead: bytes, lines, signed or unsigned, nested or not. If the user
  wants to see it, they paste it themselves. The plugin's PreToolUse hook enforces this (§ Guard).
- **Every decrypt runs in [`scripts/gpg-in-window.zsh`](scripts/gpg-in-window.zsh)**, never as
  `gpg -d` in the agent's own shell — even with the passphrase cached, that would print plaintext
  into the agent's output.
- **Plaintext never touches disk.** It stays in the script's memory or a pipe into the concealed
  clipboard writer (§ 3) — not into a clipboard manager's history either.
  Ciphertext and public keys may be saved as files; they are what you compare.
- **A public key cannot decrypt anything.** "Can the holders of key K read message M?" means
  "does M carry a public-key-encrypted session key for K's *encryption subkey*?" Answer it from M's
  packets (§ 1).
- **Every message encrypted for someone else is ALSO encrypted to the user** (`encrypt-for`, § 4),
  so the user can always decrypt what they sent. Never silently produce a copy only the recipient
  can read. Signing is a separate, opt-in choice (§ 4).
- **Never ask for the passphrase in chat.** It goes into pinentry, typed by the human.

## 1. Inspect first — none of this needs a passphrase

| Question | Instrument |
|---|---|
| Who can decrypt M? | `gpg --homedir "$(mktemp -d)" --batch --list-packets M.asc 2>/dev/null \| grep -oE 'keyid [0-9A-F]+'` — one line per recipient. The EMPTY home holds no key, so nothing is decrypted |
| What is in key file K? | `gpg --show-keys --with-colons --with-subkey-fingerprints K.asc` — reads without importing; `sub:…:e` is the encryption subkey whose 16-hex tail is the keyid above |
| Is it mine? | Compare those keyids with `gpg --list-secret-keys --with-colons` (`ssb` lines, field 5). A match means yes. **Never probe with `gpg -d`**: with the passphrase cached it decrypts and prints |
| Same public key? | Two instruments that could disagree: `gpg --dearmor` both and `cmp`, **and** compare fingerprints from `--show-keys`. Different armor text can be the same key |
| What does M decrypt to, when M is encrypted to someone else? | You cannot decrypt it. If you produced it, `cmp` it against your saved ciphertext — a byte match proves the content without opening it. Say that is the evidence |

Against the real keyring, `--list-packets` also *tries* to decrypt. Measured on GnuPG 2.5.24, it
printed no plaintext even with `-vv`, but the empty home avoids the question entirely.

**Armor pasted as one line** (a chat box or form collapsed the newlines) fails with
`gpg: no valid OpenPGP data found`. Rebuild it rather than guess: strip the BEGIN/END markers,
split off the trailing `=XXXX` CRC, `fold -w 64` the body, and put a blank line after the header.
Then compare bytes as above. Tell the user the copy they are sharing is broken the same way for
the recipient — send a `.asc` file instead.

## 2. The passphrase prompt — when the agent has no TTY

The agent's shell has no terminal, so a curses or tty pinentry fails with
`Inappropriate ioctl for device` or `No pinentry`. In order:

The script never prints plaintext — its stdout is a status line — so **where** it runs only
decides where the passphrase prompt can appear. In order:

1. **No passphrase needed:** unsigned `encrypt-for`. Run it in the agent's own shell.
2. **A GUI pinentry is configured** (`gpgconf --list-options gpg-agent | grep pinentry-program`
   names e.g. `pinentry-mac`): run the script **in the agent's own shell** too. The dialog appears
   on the Mac's screen. This is the preferred setup — no window, no tab limits, and the clipboard's
   auto-clear survives (it does not in a window, below). Configure it with
   `no-allow-external-password-cache`, or pinentry-mac's **Save in Keychain** box lets every later
   decrypt run silently, from any process, forever.
   ```bash
   S=scripts/gpg-in-window.zsh
   zsh $S first-word "$PWD/M.asc"                     # decrypt a saved message
   zsh $S all - "$PWD/run1"                           # decrypt the message ON THE CLIPBOARD
   zsh $S encrypt-for "$PWD/THEIRS.asc" "$PWD/run2" sign   # § 4, signed
   ```
3. **Only a curses/tty pinentry:** run the same commands in a real terminal window,
   `open -na Ghostty.app --args -e /bin/zsh $S …`, and wait for the status file with a
   backgrounded `until [ -s <prefix>.status ]` loop. Terminal.app via `osascript … do script` is
   the untested alternative; the traps below are what carries over.

It writes `<prefix>.status` (lengths, flags, recipient keyids) and `<prefix>.diag` (gpg's stderr),
never plaintext; the prefix defaults to the message path and is required with `-` and
`encrypt-for`. Exit 0 on OK, 1 on FAILED.

**Remote use (the user on a phone):** every route puts the prompt on the Mac's screen. If the
user is not at the Mac, decrypting and signing cannot happen — say so rather than retrying.

**Traps in the window route, measured with Ghostty 1.3 and pinentry-curses 1.3.3 (2026-10):**
- A freshly opened window's pty is **0×0** when the command starts, so pinentry fails at once with
  `Screen or window too small`. The script waits until `stty size` reports ≥ 10 rows.
- The terminal's own `TERM` (e.g. `xterm-ghostty`) may have no terminfo entry in the pinentry's
  ncurses. The script exports `TERM=xterm-256color`.
- **Closing the window kills a delayed background job, even under `nohup`**; the agent's own shell
  keeps it (measured with marker files). So in a window the script stays open with a countdown
  until the clipboard has auto-cleared, and says so if the user closes it early.

An in-app terminal panel is the other option, but one measured host caps a session at **6 tabs**
and refuses to close a tab the human has typed in — and typing a passphrase counts. Six decrypts
filled it. The window route has no such cap.

## 3. Decrypt — report without revealing

- **Input** is a saved file, or `-` for the message already on the clipboard. The clipboard case is
  read into memory (inside the script) **before** anything writes the clipboard: one pipeline that
  both reads and writes the clipboard lets a writer that clears it first race the reader.
- **Decrypted text is written CONCEALED with `pb-conceal`** when it is on PATH: an
  `org.nspasteboard.ConcealedType`, host-only item that clipboard managers (Maccy, Alfred, Raycast,
  Paste) do not record and Universal Clipboard does not sync, cleared after `$PGP_CLEAR` seconds
  (default 90; `0` = never). **Plain `pbcopy` puts the plaintext into the clipboard manager's
  history on disk** — without pb-conceal the status says `concealed=NO`, and you say so.
- **`all`** pipes `gpg -d` straight into that writer under `pipefail`: byte-exact, and a failure
  empties the clipboard (documented trade-off in the script).
- **`first-word`** stops at any whitespace; **`before-space`** stops at the first literal space, so
  a first line ending in a newline is included. Use the one the user's words name.
- **Check the clipboard independently** of the script's own report, by count or digest only:
  `pbpaste | wc -c`, `pbpaste | shasum -a 256`. Anything else that reads the clipboard (`grep`,
  `head`, a bare `pbpaste`, `$(pbpaste)`) is a read of the plaintext, and the guard refuses it.
- **Nested armor:** if the plaintext is itself `-----BEGIN PGP MESSAGE-----`, the user received a
  second layer, often addressed to someone else. Run § 1 on the inner message and say whose it is.
- **Signed or not:** read `.diag`. No `Good signature` / `Signature made` line means unsigned, so the
  sender is not proven, even though it was encrypted to the user.

## 4. Encrypt for someone

**Encrypting to yourself is what lets you read it later — signing is not.** Only a session key for
*your* encryption subkey lets you decrypt your own sent copy. A signature proves the message came
from you and nothing more. Users often ask for "sign it so I can read it later": that is a request
for the self-recipient, so correct the conflation and give them that.

**The default, always: `encrypt-for`, unsigned, to them AND to the user.** Put the plaintext on the
clipboard (the user copies it, or `pbcopy` from what they typed), save the recipient's public key as
`THEIRS.asc`, then:
```bash
zsh scripts/gpg-in-window.zsh encrypt-for "$PWD/THEIRS.asc" "$PWD/run1"
```
No passphrase, so no window. The user's key is `$PGP_SELF`, else the only secret key. Before the
clipboard is replaced, the result's packets must name **both** the user's and the recipient's
encryption subkeys, or nothing changes and the plaintext stays on the clipboard. The status line
reports `self-recipient=yes signed=no`.

**Signed, opt-in:** add `sign` when the user asks for a signature (proof of authorship). It needs
the passphrase, so run it in the window (§ 2). It also proves the round trip: the user's key must
decrypt the result back to the same sha256 with a `Good signature`.

**Recipient-only (no copy for the user) — ONLY on an explicit request**, and say first that the
user can never read that copy again. Use `--no-encrypt-to` too, because a GnuPG `encrypt-to` line
in `gpg.conf` adds the user anyway (§ Adapter):
```bash
gpg --batch --yes --armor --encrypt --no-encrypt-to --recipient-file THEIRS.asc --output OUT.asc IN.txt
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

## Guard — the mechanical floor under the clipboard-only rule

The plugin ships a PreToolUse hook, `scripts/plaintext-guard.js`, on the Bash tool, a fallback
shell server's exec tools and computer-use `read_clipboard`. It **refuses**:

- `gpg`/`gpg2`/`gpgtar` that decrypt (`-d`, `--decrypt*`, a short-option cluster with `d`), and a
  `gpg` call with **no explicit command**. Its default action on an encrypted file decrypts and
  writes the plaintext next to it (measured: `gpg m.asc` printed nothing and created `m`).
- `pbpaste` unless it is piped straight into a count or digest (`wc`, `shasum`/`sha*sum`, `md5`,
  `openssl dgst`, `cmp`), into `pbcopy`, or into a gpg stage that can only encrypt, list packets,
  show or import keys, or dearmor. After a decrypt the clipboard **is** the plaintext.
- osascript reading the clipboard, NSPasteboard, pyperclip, xclip/xsel `-o`, wl-paste, and
  computer-use `read_clipboard`.

**Its limit:** it reads command text, so a script the agent writes and then runs is opaque to it.
The rule above binds regardless. `tests/guard-cases.sh` asserts 68 cases, including every command
this skill tells the agent to run, so the guard never pushes the agent toward a workaround.

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
| GnuPG | Homebrew `gnupg`, deliberately no second GnuPG stack. Its own `pinentry` is curses/tty only |
| GUI pinentry | Homebrew `pinentry-mac` (same Homebrew stack, not a second GnuPG), with `pinentry-program` + `no-allow-external-password-cache` in `~/.gnupg/gpg-agent.conf`, declared in the harness — so § 2.2 applies |
| Concealed clipboard | `pb-conceal` (the keychain-secrets capsule) — on PATH, so decrypts are concealed and auto-cleared |
| GUI | GpgFrontend cask; restart it to see keys created from the CLI |
| Self-recipient everywhere | `encrypt-to <own fingerprint>` in a **local, hand-placed** `~/.gnupg/gpg.conf`, so every encryption from any tool (CLI, GpgFrontend) includes the user. Never declared in a repo, because a key id in a public tree links the key to its owner. `--no-encrypt-to` opts out per command |
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
