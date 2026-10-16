# aws-infin8

The managed **AWS MCP Server** (`https://aws-mcp.us-east-1.api.aws/mcp`), signed with the
Infin8 IT Identity Center SSO profiles:

| `aws_profile` | Account | When |
|---|---|---|
| `infin8-takeoff-sdlc` | SDLC | **default**, used when a call names no profile |
| `infin8it-takeoff-prod` | production | only when a call passes it explicitly |

## Why not just the official `aws-core` plugin

`aws-core@claude-plugins-official` ships the same proxy, but with `--skip-auth`: its
documentation and skill tools work, and every AWS API call is unsigned. This plugin runs the
same pinned proxy (`mcp-proxy-for-aws-cli==1.7.0`) with `--profile <sdlc> <prod>` instead,
which (from the proxy's own `--help`) makes the first profile the default and adds an
`aws_profile` enum to every tool for per-call switching.

Measured 2026-10-16, `aws___run_script` → `sts:GetCallerIdentity`:

- no `aws_profile` → the SDLC account, `AWSReservedSSO_AdministratorAccess_…/<user>`
- `aws_profile: infin8it-takeoff-prod` → the production account, same permission set

The server name is `aws-mcp` on purpose: `aws-core`'s `secret-safety.py` hook matches
`mcp__plugin_.*aws-mcp.*`, so it covers this server's tools too when both are enabled.

## Credentials

No secret is in this file or in argv. The proxy reads `~/.aws/config` and the AWS CLI's SSO
token cache, exactly like `aws --profile …`. When the Identity Center session expires:

```
aws sso login --sso-session infin8
```

## Requirements

- `uv` (`uvx`) on the PATH Claude Code spawns servers from.
- Both profiles in `~/.aws/config`, sharing one `sso-session`.

## Install

```
/plugin install aws-infin8@kattakath
```
