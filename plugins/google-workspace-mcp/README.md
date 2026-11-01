# google-workspace-mcp

A **capability plugin**: it owns one stdio MCP server, [`workspace-mcp`](https://github.com/taylorwilsdon/google_workspace_mcp)
(MIT), plus that server's settings and credentials. It ships no skill. Procedures that use it,
such as [`workspace-gtd`](../workspace-gtd), live in their own plugins and declare this one as
a dependency.

## What loads

| Setting | Default | Effect |
|---|---|---|
| `tools` | `tasks` | Comma-separated services. Valid: `appscript calendar chat contacts docs drive forms gmail search sheets slides tasks` |
| `credential_command` | empty | A command prefix that runs its arguments with the OAuth client in the environment |
| `client_id`, `client_secret` | empty | The OAuth client, typed in. The secret is `sensitive`, so it goes to the OS credential store, not `settings.json` |
| `email` | empty | Sets `USER_GOOGLE_EMAIL`, which makes every tool's `user_google_email` argument optional, defaulting to this address. Measured on 2.2.1 with `tasks`: 0 of 7 tools require it with `email` set, 6 of 7 without |

- **Tasks only by default.** Google offers no hosted MCP endpoint and no claude.ai connector for
  Tasks, so this is the one service most setups need here.
- **Every other service is opt-in.** If a claude.ai connector already covers Gmail, Drive,
  Calendar, Docs or Sheets, leave them off. Two paths to one app means two tool sets.
- **Each added service widens the OAuth scopes.** The next call asks you to sign in again.
- **Chat needs a Google Workspace account** with a Chat app configured in the client's project.

## Credentials — first match wins

1. **`credential_command`**, such as `op run --env-file=/path/google.env --` or `envchain google`.
   - It must set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`, then exec its arguments.
   - It is split on spaces; quotes are not supported.
   - This is the path for a secret that already lives in a password manager or keychain, because nothing copies it.
2. **The environment**: `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`, already exported.
3. **`client_id` and `client_secret`**, prompted when the plugin is enabled, or set with
   `claude plugin configure google-workspace-mcp@kattakath`.

**Missing all three:** the server does not start. You get one message naming the three options.

### Two measured facts behind the launcher

These are why it is a script and not a plain `.mcp.json` (Claude Code 2.1.296):

- **An unset `userConfig` value substitutes as the empty string.** Mapping one straight onto
  `GOOGLE_OAUTH_CLIENT_ID` would wipe a value the environment already holds. So the fields
  arrive as `GWM_*` and only fill what is still empty.
- **An argument is not private.** A value substituted into `args` shows in `claude mcp list`
  and in `ps`. The secret travels only in the environment, and `tests/run.sh` asserts it never
  reaches argv.

The OAuth client is a Google Cloud **Desktop app** client. Enable the API of each service you
load, such as the Tasks API, in that client's project. The token lands in
`~/.google_workspace_mcp/credentials/` after the first sign-in.

## Requirements and surfaces

| Surface | Works? |
|---|---|
| Claude Code CLI (macOS, Linux) | Yes. Needs [`uv`](https://docs.astral.sh/uv/) for `uvx` |
| Claude Code on Windows | No. The launcher is POSIX `sh` |
| claude.ai / Desktop chat | No. Those surfaces do not run stdio servers from plugins |

- **Pinned:** `workspace-mcp==2.2.1`. Bump it deliberately, after reading the release notes.
- **No fixed port.** The OAuth callback binds only while you sign in. It tries one preferred
  port plus four fallbacks, so two sessions do not collide; that is `auth/port_resolver.py` in
  2.2.1.

## Why not upstream's own plugin

`taylorwilsdon/google_workspace_mcp` ships a Claude Code plugin of the same name. This plugin
borrows its `tools` setting and differs where it matters:

| | Upstream plugin | This plugin |
|---|---|---|
| Credentials | `client_id` and `client_secret` are **required** prompts, so a secret held elsewhere must be copied in | Credential command, then the environment, then the prompt |
| Default services | **All** of them | `tasks` |
| Server pin | Runs the git checkout's `main.py`, so it follows the marketplace ref | A PyPI version pin |
| Empty settings | Map straight onto `GOOGLE_OAUTH_*`, so an unset one blanks the environment | Fill only what is empty |
