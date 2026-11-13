---
name: smtp-egress
description: >-
  Send a plain-text email over authenticated SMTP through a local SOCKS5 proxy
  (wireproxy/WireGuard or Tor) so the sender's own IP never reaches the Received:
  headers, with a human approving every send. Use when the user says "send this
  email via SMTP", "send without exposing my IP", "hide my IP in email headers",
  "set up proxied SMTP", "msmtp through a proxy", or "check my email headers for an
  IP leak". Not for provider-API connectors (no client IP in headers) or bulk mail.
---

# Proxied SMTP with an egress check and a send gate

The plugin does three things a hand-run `msmtp` does not:

- it **proves** the proxy is a different network exit before every send;
- it **asks a human** before every send;
- it **proves the result** on a delivered message's headers.

It never stores or reads a secret: msmtp's own `passwordeval` does.

## Tools — use them instead of deriving

Each line below is a literal command. The guard's verdict for it is in the comment, and
`tests/guard-cases.sh` reads these lines out of this file to prove it.

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.sh"                     # allow: preflight; must exit 0
bash "${CLAUDE_PLUGIN_ROOT}/scripts/egress-check.sh"               # allow: one JSON line {direct_v4, direct_v6, proxied, ok}
bash "${CLAUDE_PLUGIN_ROOT}/scripts/new-eml.sh" --to bob@example.net --subject "Hello" --body-file body.txt   # allow: prints the outbox path
bash "${CLAUDE_PLUGIN_ROOT}/scripts/send.sh" --dry-run msg.eml     # allow: every step but msmtp
bash "${CLAUDE_PLUGIN_ROOT}/scripts/send.sh" msg.eml               # ASKS: the real send
bash "${CLAUDE_PLUGIN_ROOT}/scripts/header-check.sh"               # ASKS: sends a probe to PROBE_RECIPIENT
bash "${CLAUDE_PLUGIN_ROOT}/scripts/header-check.sh" --headers h.txt --direct-v4 198.51.100.7 --direct-v6 2001:db8:1::1   # allow: asserts saved headers only
```

State lives in `${XDG_STATE_HOME:-~/.local/state}/smtp-egress/`:

- `outbox/` holds the `.eml` files `new-eml.sh` writes.
- `sent.jsonl` gets one line per send: ts, message_id, to/cc/bcc arrays, subject, sha256,
  proxied_ip, smtpstatus. **No body.**
- `probe-<key>.pass` records a header-check PASS for this account + SOCKS endpoint.
- The wireproxy log and the probe files.

## The human gate

A PreToolUse guard returns `permissionDecision: "ask"` before:

- any run of `send.sh` without `--dry-run`, under any path or variable;
- any run of `header-check.sh` except `--headers <file>` or `--dry-run`;
- the raw bypass shapes: `msmtp` run directly, `sendmail`, `swaks`, `mail`/`mailx`/`mutt`
  with a recipient, `curl smtp(s)://`, python `smtplib.SMTP(`, and `openssl s_client` /
  `nc` / `socat` / `telnet` to :25, :465 or :587. It sees through sudo, timeout, env,
  `bash -c`, eval and pipes into a shell.

The prompt lists **every To, Cc and Bcc recipient**, the Subject and sha256[:12] of the
`.eml`. It carries **no egress verdict**: egress-check runs **after** approval, inside
`send.sh`, and a refusal there aborts the send.

- **Never pre-approve**, and never add `send.sh` to an allow rule.
- **A declined send is final.** Do not retry it, rephrase it, or send it another way.
- **A non-250 is reported, never auto-retried.** Tell the user what msmtp said and stop.

## Exit codes

| Script | 0 | 1 | 2 |
|---|---|---|---|
| `egress-check.sh` | ok | refused | config error |
| `send.sh` | sent / dry run ok | refused, or not accepted (non-250) | config error |
| `header-check.sh` | PASS (or probe sent, checklist printed) | FAIL or refused | config error |
| `new-eml.sh` | written | — | usage or config error |
| `doctor.sh` | every row ok (WARN allowed) | a row FAILED | — |

## Config (the operator writes it by hand; never in a repo)

`${SMTP_EGRESS_CONFIG:-$XDG_CONFIG_HOME/smtp-egress/config}`, `KEY=VALUE`, mode **600**.
It is parsed, never sourced, so a `$(…)` in a value is inert text.

| Key | Meaning |
|---|---|
| `MSMTP_CONFIG` | Path to the msmtprc |
| `MSMTP_ACCOUNT` | msmtp account name; its `from` must equal the `.eml` From |
| `SOCKS_HOST` / `SOCKS_PORT` | Default `127.0.0.1` / `25344` |
| `WIREPROXY_CONFIG` | Optional. egress-check starts wireproxy when the port is closed |
| `PROBE_RECIPIENT` | An EXTERNAL mailbox, outside the sending account, for header-check |
| `ALLOWLIST_FILE` | Optional. One address or `@domain` per line; any other recipient refuses. The prompt is required either way |
| `IMAP_HOST` `IMAP_PORT` `IMAP_USER` `IMAP_PASSWORDEVAL` `IMAP_MAILBOX` | Optional. header-check reads the probe back over IMAPS (`BODY.PEEK[HEADER]`, by Message-ID), searching `IMAP_MAILBOX` (default INBOX) and then `[Gmail]/Spam` if it exists. `IMAP_PASSWORDEVAL` is a command that prints the password, like msmtp's `passwordeval` |

A minimal msmtprc account (example values):

```
defaults
auth on
tls on
tls_starttls on
account example
host smtp.gmail.com
port 587
from alice@example.com
user alice@example.com
passwordeval "printenv SMTP_PW"
```

- Run msmtp's `passwordeval` under the operator's own secret tool (one that exports
  `SMTP_PW` for the child only), or read the macOS keyring.
- No proxy lines are needed: `send.sh` passes `--proxy-host`/`--proxy-port` explicitly.
- Keep `from` equal to `user`. doctor.sh and send.sh WARN when they differ (a send-as alias).
- Leave `domain` unset. It defaults to `localhost`; a real hostname there leaks in EHLO.

A wireproxy config needs `WGConfig = <path>` plus a `[Socks5]` section with
`BindAddress = 127.0.0.1:<SOCKS_PORT>`. Check it with `wireproxy -n -c <conf>`.

## Procedure

1. **`doctor.sh` must exit 0.** Fix every FAIL row first. A WARN row does not block, but
   tell the user about it.
2. **`egress-check.sh`** must print `"ok": true`. A refusal names the reason in one line.
   Do not work around it.
3. **`header-check.sh`** when doctor's `probe-pass` row says **none**: that means first use,
   or the account or SOCKS endpoint changed. It asks. With IMAP keys it asserts by itself.
   Without them it prints the Message-ID and a checklist:
   - open that message in PROBE_RECIPIENT's mailbox with any mail reader you have;
   - save the raw headers;
   - run the `--headers` line it prints. A PASS on the probe's headers is recorded.
4. **`new-eml.sh --to … --subject … --body-file …`** writes the `.eml` and prints its path.
   Add `--cc`/`--bcc` as needed. From defaults to the account's `from`.
5. **`send.sh --dry-run <path>`.** It runs every check, so the sha256 in the next prompt is
   the one that gets logged.
6. **`send.sh <path>`.** The human approves or declines in the prompt.
7. **Read the last line of `sent.jsonl`** and report the Message-ID, the recipients and
   `smtpstatus=250`.

## What egress-check decides

- It measures the direct exit, v4 and v6 separately. A missing v6 is fine.
- It measures the proxied exit through `curl --socks5-hostname`, from
  `https://www.cloudflare.com/cdn-cgi/trace`.
- It **refuses** when the proxied IP:
  - is unmeasured;
  - equals a direct IP;
  - shares the direct IPv4 **/24** or IPv6 **/48**.
- It compares IPs only, so there is no ISP, ASN or provider list to keep.

## What header-check asserts

- No `Received: from … [IP]` hop, the first hop included, lies in the direct /24 or /48.
- No `Sender:` header.
- `dmarc=pass` and `dkim=pass` in Authentication-Results.
- A DKIM `d=` other than the From domain is a **WARNING** only.

## Edge cases

- **Gmail send-as aliases add a `Sender:` header** naming the primary account. Send from
  the mailbox itself, not from an alias of another account.
- **A self-send proves nothing.** It never leaves the provider, so it skips the external
  hop and DKIM. A self-sent message measured only 623 bytes of headers.
  - header-check refuses a probe to the same mailbox after lowercasing, dropping a display
    name and a `+tag`, and dropping Gmail dots (gmail.com/googlemail.com).
  - It cannot see other provider-side aliases. Choose a mailbox at another provider.
- **A system VPN changes what "direct" means.** egress-check compares the proxy against
  whatever this machine's default route exits through. If that is the same exit as the
  proxy, egress-check falsely refuses. Run the checks with the system VPN off, or give the
  proxy a different exit than the VPN.
- **A system VPN that leaves IPv6 outside the tunnel leaks.** The SMTP server is reached
  over v6 from the real address. A SOCKS proxy carries the connection itself, whatever the
  family, which is why this plugin uses one.
- **egress-check measures curl's path, not msmtp's.** Both use the same SOCKS endpoint, but
  only header-check, on a delivered message, proves what msmtp's connection exposed.
- **msmtp's `domain` setting goes into EHLO**, and the first `Received:` header records
  it. Keep it at the default `localhost`.
- **Gmail on the web hides the client IP; SMTP does not.** SMTP submission puts the
  connecting IP in the first `Received:` header.
- **App passwords need 2-Step Verification** on the account, and a Workspace admin must
  allow them.
- **DKIM `d=*.gappssmtp.com`** means the domain's own DKIM signing is off. DKIM then does
  not align, so DMARC rests on SPF alone. That is cosmetic only while the domain's SPF
  record includes the provider.
- **Tor exits are often challenged** by Google logins, and Tor circuits rotate. A pass from
  egress-check or header-check holds for that circuit only. Prefer a WireGuard exit.
- **The Received parser is tested on Gmail-shaped headers only.** On another provider,
  read the first hop yourself before trusting a PASS.
- **IMAP read-back connects directly**, not through the proxy. Only the probe mailbox's
  provider sees that login. It does not enter any message header.
