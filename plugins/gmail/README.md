# gmail

Several Gmail accounts, each as its **own** MCP server, started per session by Claude Code
and reaped when the session ends. No proxy, no listening socket, no shared process.

| server | account |
|---|---|
| `kattakath` | ismail@kattakath.com |
| `personal` | ismailkattakath@gmail.com |

## It needs a companion on PATH

Each entry in `.mcp.json` names one binary, not a package, and passes the address:

```json
{ "kattakath": { "command": "nix-mcp-gmail", "args": ["ismail@kattakath.com"] } }
```

That launcher comes from **`kattakath/nix-config`** — `packages/gmail-mcp.nix`,
installed by `local.gmailMcp`. It derives the per-account alias from the address at
launch, so adding an account is an `args` entry here, not a Nix change. Same arrangement as
`claude-code-nix` with `mcp-nixos` and `page-lab` with `page-lab-pick`: the plugin
declares, Nix installs.

**Why the credential work is not in this repo.** The launcher reads
`GMAIL_OAUTH_CLIENT_ID` and `GMAIL_OAUTH_CLIENT_SECRET` from the macOS login Keychain at
launch and writes a `0600` `~/.gmail-mcp/gcp-oauth.keys.json`. A plugin's `.mcp.json` can
set `env` to literals or passthroughs but cannot run a Keychain read — and putting the
logic here would mean a second copy of credential handling in a second repo. So the
secret path stays in one place, in Nix, where it is reviewed.

Without the launchers on PATH the servers simply fail to start. Nothing here can fix
that; install them from nix-config.

## First run needs a browser, once per account

The OAuth client id/secret are shared across every account, but each account stores its own
token. The launcher prints the exact command when a token is missing:

```
GMAIL_OAUTH_PATH=~/.gmail-mcp/gcp-oauth.keys.json \
  GMAIL_CREDENTIALS_PATH=~/.gmail-mcp/credentials-<alias>.json \
  npx -y @artymclabin/gmail-mcp auth
```

## Tool names carry a second prefix, and that is deliberate

The upstream server is launched with `--tool-prefix=<alias>_`, so a tool reads
`mcp__plugin_gmail_kattakath__ismail_kattakath_com_search_emails`. The server name
already disambiguates the accounts here, so the inner prefix is redundant in this lane — it
is kept because the launcher is shared with nix-config and the prefix is what keys each
account's tools apart there. Dropping it is a change to make in nix-config, not here.

## Replaces part of a retired gateway

Until 2026-10-01 these accounts ran inside a single `mcp-proxy` on `127.0.0.1`, published
through a Cloudflare portal. That central gateway was removed; this plugin is how the
capability survives it. The portal also served **Claude Desktop**, which loads no plugins
— so Desktop has no Gmail MCP and this plugin cannot give it one.
