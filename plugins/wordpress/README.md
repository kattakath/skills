# wordpress

Site administration over the **WordPress REST API** — `docdyhr/mcp-wordpress`, ~59 tools
covering posts, pages, media, categories/tags, comments, users, site settings, cache and an
SEO group. One MCP server, started per session by Claude Code and reaped when the session
ends. No proxy, no listening socket.

## This points at PRODUCTION

There is no staging site behind it. The tool list includes `wp_update_post`,
`wp_delete_page`, `wp_update_site_settings`, `wp_delete_user` and
`wp_seo_bulk_update_metadata` — all of which take effect on the live site immediately.
Read before you write, and prefer a revision-creating update (`wp_update_post`) over a
delete.

## It needs a companion on PATH

`.mcp.json` names a binary, not a package:

```json
{ "wordpress": { "command": "nix-mcp-wordpress" } }
```

That launcher comes from **`kattakath/nix-config`** — `modules/shared/plugin-mcp.nix`
builds it when `local.pluginMcp.servers` includes `"wordpress"`. Same arrangement
`claude-code-nix` has with `mcp-nixos` and `page-lab` with `page-lab-pick`: the plugin
declares, Nix installs. Without it on PATH the server simply fails to start.

**Why the credential work is not in this repo.** The launcher reads three values from the
macOS login Keychain at launch — the site URL, the username and an **application
password**. A plugin's `.mcp.json` can set `env` to literals or passthroughs but **cannot**
run a Keychain read. The site URL is stored alongside the credentials deliberately, so even
which site this administers is not published here.

## Application password, not the account password

Authentication is WordPress's own **application-passwords** scheme (advertised at
`/wp-json/` under `authentication`), issued per application from
`/wp-admin/authorize-application.php` and revocable without touching the account password.
Basic auth over HTTPS, which is why `https` is not optional.

## The REST API is a different endpoint from the MCP Adapter

Do not confuse this with a `wordpress-adapter` server. That one spoke to the **WordPress
MCP Adapter plugin** at `/wp-json/mcp/...`; the Adapter was removed from the site, the
`mcp` namespace is gone, and that route now returns `404 rest_no_route`. **This** plugin
uses `/wp-json/wp/v2/...`, which is WordPress core and was verified live on 2026-10-02:
`/wp-json/` answers `200` with `wp/v2` present, and `/wp-json/wp/v2/users/me` answers `401
rest_not_logged_in` — the route exists and only authentication gates it. There is
deliberately no adapter plugin here, because a plugin for a dead endpoint is worse than no
plugin.

## Replaces part of a retired gateway

Until 2026-10-02 this server ran inside a single `mcp-proxy` on `127.0.0.1`, published
through a Cloudflare portal. That gateway and portal are gone; this plugin is how the
capability survives them. The portal also served **Claude Desktop**, which loads no plugins
— so Desktop has no WordPress MCP and this plugin cannot give it one.
