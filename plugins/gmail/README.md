# gmail

Four Gmail accounts, each as its **own** MCP server, started per session by Claude Code
and reaped when the session ends. No proxy, no listening socket, no shared process.

| server | account |
|---|---|
| `kattakath` | ismail@kattakath.com |
| `personal` | ismailkattakath@gmail.com |
| `silvercreek` | izzy@silvercreek.ai |
| `aloshy` | aloshyakasoto@gmail.com |

## It needs a companion on PATH

Each entry in `.mcp.json` names a binary, not a package:

```json
{ "kattakath": { "command": "nix-mcp-gmail-ismail_kattakath_com" } }
```

Those launchers come from **`kattakath/nix-config`** — `modules/shared/gmail-mcp.nix`
builds one per address listed in `local.gmailMcp.accounts`. Same arrangement as
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

The OAuth client id/secret are shared across all four, but each account stores its own
token. The launcher prints the exact command when a token is missing:

```
GMAIL_OAUTH_PATH=~/.gmail-mcp/gcp-oauth.keys.json \
  GMAIL_CREDENTIALS_PATH=~/.gmail-mcp/credentials-<alias>.json \
  npx -y @artymclabin/gmail-mcp auth
```

## Tool names carry a second prefix, and that is deliberate

The upstream server is launched with `--tool-prefix=<alias>_`, so a tool reads
`mcp__plugin_gmail_kattakath__ismail_kattakath_com_search_emails`. The server name
already disambiguates the four here, so the inner prefix is redundant in this lane — it
is kept because the launcher is shared with nix-config and the prefix is what keys each
account's tools apart there. Dropping it is a change to make in nix-config, not here.

## Replaces part of a retired gateway

Until 2026-10-01 these four ran inside a single `mcp-proxy` on `127.0.0.1`, published
through a Cloudflare portal. That central gateway was removed; this plugin is how the
capability survives it. The portal also served **Claude Desktop**, which loads no plugins
— so Desktop has no Gmail MCP and this plugin cannot give it one.
