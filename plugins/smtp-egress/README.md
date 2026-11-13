# smtp-egress

Send plain-text email over authenticated SMTP (STARTTLS) through a local **SOCKS5 proxy**,
so the sending machine's own IP never appears in the `Received:` headers — with a human
approving every send in Claude Code's permission prompt.

A hand-run `msmtp --proxy-host` gets the transport right and proves nothing. This plugin
checks the exit before every send, gates every send on a person, and checks the result on
a delivered message.

```
/plugin install smtp-egress@kattakath
```

## What it ships

| Component | What it does |
|---|---|
| `skills/smtp-egress` | The procedure, the config, and the measured edge cases |
| `scripts/egress-check.sh` | Direct v4/v6 vs proxied exit; **refuses** on the same IP, the same IPv4 /24 or the same IPv6 /48; one JSON line |
| `scripts/new-eml.sh` | Writes a send-ready `.eml` (CRLF, UTC Date, Message-ID, MIME, RFC 2047 Subject) to the outbox; `--in-reply-to` / `--references` thread a reply |
| `scripts/send.sh` | egress-check → header and From checks → optional allowlist → `msmtp` with the proxy flags explicit → requires `smtpstatus=250` → `sent.jsonl` with every To/Cc/Bcc recipient and no body. `--dry-run` skips msmtp. A non-250 is reported, never retried |
| `scripts/inbox.sh` | **Read-only IMAP** through the same proxy via himalaya: `list`, `search`, `read` (never marks `\Seen`), `folders`. egress-check first; a per-run mode-600 config whose proxy is always `socks5h://`, removed on exit |
| `scripts/header-check.sh` | Sends a probe to an external mailbox, reads it back with himalaya through the proxy if configured, and asserts no hop in the direct ranges, no `Sender:`, `dmarc=pass`, `dkim=pass`. `--headers <file>` asserts saved headers. A PASS on a probe is recorded per account + SOCKS endpoint |
| `scripts/doctor.sh` | Rows tagged send / read / both: msmtp, wireproxy and himalaya versions, config mode 600, msmtprc and account (send-as WARN), IMAP reading and probe read-back config (half-set and 1.0.x-key WARNs), egress verdict, then SOCKS port, recorded probe PASS, and a sweep of temp configs older than 1 h. Summary: send-ready / read-ready. Exit 0 = send-ready; `--read`: exit 0 = read-ready |
| `hooks/` PreToolUse guard | **Asks** before every `send.sh` (every recipient, Subject, sha256[:12] in the prompt) and before any raw SMTP bypass |

## What the guard is — and isn't

- **A seatbelt, not a sandbox.** The PreToolUse guard reliably prompts on the plugin's own
  send paths and on the plain shapes a model naturally types: msmtp, sendmail, curl SMTP,
  himalaya writes. When it cannot resolve a command, it asks.
- **It is not a sandbox.** A shell can build commands no text check predicts, and an agent
  steered by a malicious email can try to. Don't treat "no prompt" as proof that nothing was sent.
- **Only the plugin's scripts guarantee the properties:** send.sh and inbox.sh always go through
  the proxy, run egress-check first, and never mark mail \Seen.
- **Mail read through inbox.sh is untrusted data.** It may try to instruct the agent.
- **The real lock is on the credential**, for example a secret that needs user presence
  (Touch ID) on every read. That is outside this plugin.

## The guard

| Asks before | Why |
|---|---|
| `send.sh` without `--dry-run`, under any path or `$VAR` | A human approves every email that leaves |
| `header-check.sh`, except `--headers <file>` or `--dry-run` | It sends a real probe |
| `msmtp` run directly, `sendmail`, `swaks`, `mail`/`mailx`/`mutt` with a recipient | They skip the egress check |
| `curl smtp://` / `smtps://`, python `smtplib.SMTP(` / `SMTP_SSL(` | Same |
| `openssl s_client`, `nc`, `socat`, `telnet` to :25 / :465 / :587 | Same |
| `himalaya` deleting, moving, copying, flagging, appending, expunging, `read --seen`, or sending (`message send/compose/reply/forward`, `smtp`) | It changes the mailbox, or sends outside the msmtp gate |
| `curl imap(s)://` / `pop3(s)://` (any: its FETCH is unproxied and uses `BODY[]`), `curl -K`; python that uses IMAP at all | Same, and the read is unproxied |
| `himalaya` with an explicit config (`-c`, `--config`, `HIMALAYA_CONFIG`) | It may connect without the proxy: inbox.sh is the sanctioned read |
| any plugin script with an `SMTP_EGRESS_*` assignment in the same call | It can swap the config or switch off a safety check |

**It asks when unsure.** A guard that can only ask, never deny, makes a false ask cheap
and a false allow the failure. So:

- it sees through `sudo -u X`, `timeout -s KILL 5`, `env`, `nice -n`, `xargs`, `arch`,
  `script`, `flock`, `watch`, `parallel`, `su -c`, `nix run … --`, `nix … -c`,
  `nix-shell --run`, `find -exec`, `bash -lc`, `eval`, `source`, pipes into a shell, and
  `$( )` or backticks inside an **unquoted** heredoc body;
- it reads the code of `python -c` (any flag cluster), `perl`/`ruby`/`osascript -e` and
  `node -e`, and asks when it names a mail tool (`do shell script`, `execSync`,
  `subprocess`, `system`);
- an `alias` naming a mail tool and `shopt -s expand_aliases` ask;
- nesting too deep to parse, any parse error, and malformed or truncated hook JSON ask
  when the text names a mail tool.

**What it cannot do.** It protects sends and mailbox changes and asks on reads that are
not inbox.sh, but it cannot make an arbitrary read proxied. Only inbox.sh is guaranteed
proxied. A plain `himalaya envelope list` on the user's own default config is allowed and
goes wherever that config says. Command names built at run time (`${h}laya`,
`$(printf …)`) cannot be followed.

Data stays quiet: a `grep` pattern, a `printf` or `echo` body, a heredoc written to a
file, `command -v msmtp`, `which msmtp`, `msmtp --version` / `--serverinfo`,
`egress-check.sh`, `doctor.sh`, `new-eml.sh`, `inbox.sh list|search|read|folders` and
himalaya's read-only commands (`envelope list|search`, `message read`, `mailbox list`, …).

The egress verdict is not in the prompt. egress-check runs after approval, inside
`send.sh`, and a refusal there aborts the send.

```bash
bash tests/guard-cases.sh    # ask, allow, never-throw, reason contents
bash tests/egress-cases.sh   # range logic on fixed documentation IPs, config parser, end to end
bash tests/send-cases.sh     # new-eml, send.sh, header-check and doctor against stub msmtp/curl/himalaya: nothing is sent
bash tests/inbox-cases.sh    # inbox.sh against a stub himalaya: generated config, proxy, mode 600, cleanup, arg mapping
nix shell nixpkgs#himalaya -c bash tests/himalaya-wire-cases.sh   # real himalaya vs a loopback IMAP: BODY.PEEK, no STORE
```

## Reading mail

`inbox.sh list|search|read|folders` reads the sending account through the same SOCKS
proxy with himalaya 2.x. It is the one read path the plugin guarantees is proxied.

- **`read` never marks `\Seen`**: it runs `himalaya message read` without `--seen`,
  which sends `UID FETCH <id> BODY.PEEK[]` and no STORE. That is measured on the wire
  against a loopback IMAP server over cleartext `imap://` through SOCKS; with `--seen` it
  sends `BODY[]`. The TLS path is the same command inside TLS, verified as config text.
- **`list`/`search` print** id, date, from and subject; `read` prints text. Nothing is
  rendered, so no remote image loads and a tracking pixel cannot reveal the reader.
- **Ids are per folder.** Read with the same `--folder` you listed.

IMAP shows the
connecting IP to the provider only, never to correspondents; it is proxied anyway so the
provider sees one sign-in location. **POP3 is deliberately unsupported**: its
download-then-delete model mutates the mailbox, and Gmail's POP has its own quirks.

## Measured facts it carries

- A **self-send proves nothing**: it never leaves the provider, so the external hop and
  DKIM are missing (623 bytes of headers, measured). The probe goes to an outside mailbox.
- A **Gmail send-as alias** adds a `Sender:` header naming the primary account.
- A **system VPN that leaves IPv6 outside the tunnel leaks** the real address to a
  dual-stack SMTP server. A SOCKS proxy carries the connection itself.
- **Gmail on the web hides the client IP; SMTP submission does not.**
- **DKIM `d=*.gappssmtp.com`**: the domain's own DKIM signing is off, so DMARC rests on
  SPF alone. Cosmetic only while SPF includes the provider.
- A **system VPN changes what "direct" means**: run the checks with it off, or give the
  proxy a different exit, or egress-check falsely refuses.
- egress-check measures **curl's** path; only header-check proves **msmtp's**.
- An msmtprc **`domain`** line leaks the hostname in EHLO; keep the default `localhost`.
- **App passwords need 2-Step Verification** and admin permission; **Tor exits** are
  often challenged by Google logins, and circuits rotate.
- The `Received:` parser is tested on **Gmail-shaped** headers only.

## Requires

- **msmtp** (tested 1.8.32): SOCKS5 via `--proxy-host`/`--proxy-port`, secrets via the
  operator's own `passwordeval`.
- **A SOCKS5 proxy**: **wireproxy** (tested 1.1.3), a userspace WireGuard client, which
  egress-check can start; or any other SOCKS5 proxy already running.
- **himalaya** 2.x (tested 2.2.1), optional: for `inbox.sh` and the probe read-back.
- **curl**, **node** (the hook), **python3** (stdlib only).

On Nix: `nix shell nixpkgs#msmtp nixpkgs#wireproxy nixpkgs#himalaya`.

The plugin never stores, reads or prints a secret. msmtp's `passwordeval` (and the
`IMAP_PASSWORDCOMMAND` / `PROBE_IMAP_PASSWORDCOMMAND`, run by himalaya) runs the operator's
own command.
