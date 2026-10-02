# apify

Apify Store **Actors** as tools: search the store, run an Actor, read its dataset. The
reason this plugin exists rather than a generic fetch tool is the scraping lane —
`apify/rag-web-browser` and `apify/web-fetch` get a page that a plain HTTP GET does not
(JavaScript-rendered, bot-gated, or paginated).

One MCP server, started per session by Claude Code and reaped when the session ends. No
proxy, no listening socket, nothing shared between clients.

## It needs a companion on PATH

`.mcp.json` names a binary, not a package:

```json
{ "apify": { "command": "nix-mcp-apify" } }
```

That launcher comes from **`kattakath/nix-config`** — `modules/shared/plugin-mcp.nix`
builds it when `local.pluginMcp.servers` includes `"apify"`. Same arrangement
`claude-code-nix` has with `mcp-nixos` and `page-lab` with `page-lab-pick`: the plugin
declares, Nix installs. Without it on PATH the server simply fails to start, and nothing
here can fix that.

**Why the credential work is not in this repo.** The launcher reads `APIFY_TOKEN` from the
macOS login Keychain at launch. A plugin's `.mcp.json` can set `env` to literals or
passthroughs but **cannot** run a Keychain read — and putting a token in this repo, or in a
literal `env` value, is exactly what the split avoids. So the secret path stays in one
place, in Nix, where it is reviewed.

## Local token, not the hosted OAuth bridge

Until 2026-08-19 this ran through `mcp.apify.com`, Apify's hosted bridge. That flow needs
an interactive browser redirect, which a spawned stdio server cannot complete any more than
a headless background agent could. So the server runs **locally** against the token
instead. Choosing the hosted bridge again would mean giving up unattended use.

## Billing is real

Actors consume Apify compute units against the account the token belongs to. This is not a
free local tool like a file read — a careless `call-actor` on a large crawl costs money.

## Replaces part of a retired gateway

Until 2026-10-02 this server ran inside a single `mcp-proxy` on `127.0.0.1`, published
through a Cloudflare portal. That gateway and portal are gone; this plugin is how the
capability survives them. The portal also served **Claude Desktop**, which loads no plugins
— so Desktop has no Apify MCP and this plugin cannot give it one.
