# Key generation — the decisions, and how each was checked

## Who sees the user ID

| Where the public key goes | Is the user ID (name + email) visible? |
|---|---|
| Sent directly, or exported from a GUI | Yes, to the recipient and anyone they forward it to |
| keys.openpgp.org | Only after the address owner verifies it — "identity information … is only distributed with consent" (its *About* page) |
| SKS-style keyservers (e.g. keyserver.ubuntu.com) | Yes, publicly; they do not delete (well known, not re-checked here) |
| A forge's GPG-key settings | On the user's key list; must match a verified account email for "Verified" commits |

User IDs can be **added** later; **revoking** one only marks it, and copies already distributed keep
it. Start with the fewest identities. A pseudonym with no email is a valid user ID; mail clients
that match keys by sender address will not auto-select it.

## "Make it from my SSH key" — possible, and why to advise against it

**Linkability.** The OpenPGP key built on an SSH ed25519 keygrip carries the *same* public key.
Check it the user's own forge publishes it:

```bash
blob=$(cut -d' ' -f2 ~/.ssh/id_ed25519.pub)
gh api --paginate users/<user>/keys --jq '.[].key' | cut -d' ' -f2 | grep -cxF "$blob"
gh api --paginate users/<user>/ssh_signing_keys --jq '.[].key' | cut -d' ' -f2 | grep -cxF "$blob"
```

A hit means anyone holding the PGP public key can run `gpg --export-ssh-key '<fpr>!'` and match it
to the user's account, even with no user ID. A probe that can say yes is the control: run it for the
SSH key (expect ≥ 1) and for a fresh PGP key (expect 0).

**Also:** two copies of the secret (`~/.ssh` and gpg-agent's store, separate passphrases), and the
fingerprint hashes the creation time, so re-deriving later gives a different fingerprint unless the
time is pinned.

**Tooling:** `ssh-to-pgp` converts RSA only (`convert.go`: "only RSA keys are supported"). The
GnuPG-native route is: import the SSH key into gpg-agent through its SSH socket, then build an
OpenPGP primary on the keygrip.

### Rehearse it with zero risk first

Everything below runs in a throwaway GNUPGHOME with a throwaway SSH key and a fake pinentry, so it
needs no passphrase and touches nothing real. The `$TMPDIR` path keeps the agent's socket path
under macOS's 104-byte `sun_path` limit.

```bash
S=$(mktemp -d "$TMPDIR/gpgr.XXXX"); chmod 700 "$S"
trap 'gpgconf --homedir "$S" --kill all' EXIT
cat >"$S/pin" <<'EOF'
#!/bin/sh
echo "OK ready"
while read -r cmd _; do
  case "$cmd" in GETPIN) echo "D rehearsal"; echo OK ;; BYE) echo OK; exit 0 ;; *) echo OK ;; esac
done
EOF
chmod +x "$S/pin"
printf 'enable-ssh-support\npinentry-program %s\n' "$S/pin" >"$S/gpg-agent.conf"
ssh-keygen -q -t ed25519 -N '' -f "$S/k"
gpgconf --homedir "$S" --launch gpg-agent
SSH_AUTH_SOCK="$S/S.gpg-agent.ssh" /usr/bin/ssh-add "$S/k"
GRIP=$(grep -Eo '^[0-9A-F]{40}' "$S/sshcontrol" | head -1)
printf 'Key-Type: eddsa\nKey-Grip: %s\nKey-Usage: sign\nName-Real: Rehearsal\nExpire-Date: 2y\n%%commit\n' "$GRIP" >"$S/params"
gpg --homedir "$S" --batch --pinentry-mode ask --gen-key "$S/params"
```

Prove it with an instrument that could disagree. Keygrip equality is circular, since you supplied
the grip:
`gpg --homedir "$S" --export-ssh-key '<fpr>!'` must equal the `.pub` blob byte for byte, and
`--list-packets` must show `version 4`. Then `gpg --quick-add-key <fpr> cv25519 encr 2y` adds the
encryption subkey, because an ed25519 key can only sign and certify.

For the real key: `SSH_AUTH_SOCK=$(gpgconf --list-dirs agent-ssh-socket) ssh-add ~/.ssh/id_ed25519`
asks for the SSH passphrase, then pinentry asks for a new gpg-agent one. Run it in a terminal window,
as in SKILL.md § 2, after `gpg-connect-agent updatestartuptty /bye` so pinentry finds the tty. The
SSH agent protocol carries no tty of its own.

## The fresh key — the recommended default

Run in a terminal window (the human types the passphrase twice, then once more to unlock for the
subkey):

```bash
export GPG_TTY=$(tty) && gpg --quick-generate-key "<uid>" ed25519 sign,cert 2y && \
fpr=$(gpg --with-colons --list-secret-keys "<uid>" | grep -m1 '^fpr:' | cut -d: -f10) && \
gpg --quick-add-key "$fpr" cv25519 encr 2y && gpg --list-secret-keys --keyid-format long "<uid>"
```

Checks: `[SC]` primary plus `[E]` subkey; packet `version 4`; and the forge-key probe above returns
**0** for the new key. GnuPG writes the revocation certificate to `openpgp-revocs.d/<FPR>.rev`, so
back it up with the key (SKILL.md § 6).
