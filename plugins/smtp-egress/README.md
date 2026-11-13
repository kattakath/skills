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
| `scripts/new-eml.sh` | Writes a send-ready `.eml` (CRLF, UTC Date, Message-ID, MIME, RFC 2047 Subject) to the outbox |
| `scripts/send.sh` | egress-check → header and From checks → optional allowlist → `msmtp` with the proxy flags explicit → requires `smtpstatus=250` → `sent.jsonl` with every To/Cc/Bcc recipient and no body. `--dry-run` skips msmtp. A non-250 is reported, never retried |
| `scripts/header-check.sh` | Sends a probe to an external mailbox, reads it back over IMAP if configured, and asserts no hop in the direct ranges, no `Sender:`, `dmarc=pass`, `dkim=pass`. `--headers <file>` asserts saved headers. A PASS on a probe is recorded per account + SOCKS endpoint |
| `scripts/doctor.sh` | Tools and versions, config mode 600, msmtprc, a send-as WARN, egress verdict, SOCKS port, recorded probe PASS; exits 1 on any failing row |
| `hooks/` PreToolUse guard | **Asks** before every `send.sh` (every recipient, Subject, sha256[:12] in the prompt) and before any raw SMTP bypass |

## The guard

| Asks before | Why |
|---|---|
| `send.sh` without `--dry-run`, under any path or `$VAR` | A human approves every email that leaves |
| `header-check.sh`, except `--headers <file>` or `--dry-run` | It sends a real probe |
| `msmtp` run directly, `sendmail`, `swaks`, `mail`/`mailx`/`mutt` with a recipient | They skip the egress check |
| `curl smtp://` / `smtps://`, python `smtplib.SMTP(` / `SMTP_SSL(` | Same |
| `openssl s_client`, `nc`, `socat`, `telnet` to :25 / :465 / :587 | Same |

**It asks when unsure.** A guard that can only ask, never deny, makes a false ask cheap
and a false allow the failure. So:

- it sees through `sudo -u X`, `timeout -s KILL 5`, `env`, `nice -n`, `xargs`,
  `nix … -c`, `find -exec`, `bash -lc`, `eval`, `source` and pipes into a shell;
- nesting too deep to parse, or any parse error, asks when the text names a mail tool.

Data stays quiet: a `grep` pattern, a `printf` or `echo` body, a heredoc written to a
file, `command -v msmtp`, `which msmtp`, `msmtp --version` / `--serverinfo`,
`egress-check.sh`, `doctor.sh` and `new-eml.sh`.

The egress verdict is not in the prompt. egress-check runs after approval, inside
`send.sh`, and a refusal there aborts the send.

```bash
bash tests/guard-cases.sh    # ask, allow, never-throw, reason contents
bash tests/egress-cases.sh   # range logic on fixed documentation IPs, config parser, end to end
bash tests/send-cases.sh     # new-eml, send.sh, header-check and doctor against stub msmtp/curl: nothing is sent
```

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
- **curl**, **node** (the hook), **python3** (stdlib only).

On Nix: `nix shell nixpkgs#msmtp nixpkgs#wireproxy`.

The plugin never stores, reads or prints a secret. msmtp's `passwordeval` (and the
optional `IMAP_PASSWORDEVAL`) runs the operator's own command.
