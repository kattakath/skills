# github-gh

GitHub's official MCP server, [`github/github-mcp-server`](https://github.com/github/github-mcp-server),
authenticated with **the gh CLI's own token**.

## Why not the official `github` plugin

`github@claude-plugins-official` points at the hosted `api.githubcopilot.com/mcp/` with
`Authorization: Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}`. That needs a PAT exported into
Claude Code's own environment, where every child process can read it, and a second
credential to rotate next to gh's.

This plugin names a binary, `nix-mcp-github`, which
[kattakath/nix-config](https://github.com/kattakath/nix-config) builds
(`modules/home/plugin-mcp.nix`, server `github`). At launch it runs `gh auth token`, exports
it as `GITHUB_PERSONAL_ACCESS_TOKEN` to the server process only, and execs the
nixpkgs-pinned `github-mcp-server stdio --toolsets all`. The server's reach is exactly
gh's: widen gh's scopes (`gh auth refresh -s …`) and the server follows on its next start.

Measured 2026-10-16 under a launchd-minimal environment: 90 tools, `get_me` returns the gh
user, and repository reads succeed.

## Requirements

- `nix-mcp-github` on PATH (`local.pluginMcp.servers = [ "github" ]` in nix-config).
- `gh auth login` done once.

## Install

```
/plugin install github-gh@kattakath
```
