#!/bin/sh
# google-workspace-mcp launcher: resolve credentials, then exec the pinned workspace-mcp.
#
# Why a script and not plain .mcp.json `env`: an unset userConfig value substitutes as
# the EMPTY STRING (measured, CLI 2.1.296), so mapping one straight onto
# GOOGLE_OAUTH_CLIENT_ID would blank a value the environment already holds. userConfig
# therefore arrives under GWM_* names and only fills what is still empty here.
#
# Precedence: credential command > inherited environment > userConfig fields.
# Secrets travel in the environment only. An argv value is printed by `claude mcp list`
# and visible in `ps` (measured), so nothing secret is ever passed as an argument.
set -eu

PIN='workspace-mcp==2.2.1'
ALL='appscript calendar chat contacts docs drive forms gmail search sheets slides tasks'

die() {
  printf 'google-workspace-mcp: %s\n' "$1" >&2
  exit 1
}

# 1. Credential command: re-run this script under it, once, so it can set the env.
if [ -n "${GWM_CREDENTIAL_COMMAND:-}" ] && [ -z "${GWM_WRAPPED:-}" ]; then
  GWM_WRAPPED=1
  export GWM_WRAPPED
  set -f
  # shellcheck disable=SC2086 # word-splitting the prefix is the documented contract
  exec $GWM_CREDENTIAL_COMMAND "$0" "$@"
fi

# 2. Inherited environment wins over 3. the userConfig fields.
GOOGLE_OAUTH_CLIENT_ID=${GOOGLE_OAUTH_CLIENT_ID:-${GWM_CLIENT_ID:-}}
GOOGLE_OAUTH_CLIENT_SECRET=${GOOGLE_OAUTH_CLIENT_SECRET:-${GWM_CLIENT_SECRET:-}}
[ -n "$GOOGLE_OAUTH_CLIENT_ID" ] && [ -n "$GOOGLE_OAUTH_CLIENT_SECRET" ] ||
  die "no OAuth client. Set credential_command, export GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET, or fill client_id and client_secret (/plugin configure google-workspace-mcp)."
export GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET

if [ -n "${GWM_EMAIL:-}" ]; then
  USER_GOOGLE_EMAIL=$GWM_EMAIL
  export USER_GOOGLE_EMAIL
fi

tools=$(printf '%s' "${GWM_TOOLS:-tasks}" | tr ',' ' ')
[ -n "$(printf '%s' "$tools" | tr -d ' ')" ] || tools=tasks
for t in $tools; do
  case " $ALL " in
    *" $t "*) ;;
    *) die "unknown service '$t' in tools. Valid: $ALL" ;;
  esac
done

command -v uvx >/dev/null 2>&1 ||
  die "uvx not found on PATH. Install uv (https://docs.astral.sh/uv/) and restart Claude Code."

unset GWM_TOOLS GWM_CREDENTIAL_COMMAND GWM_CLIENT_ID GWM_CLIENT_SECRET GWM_EMAIL GWM_WRAPPED
# shellcheck disable=SC2086 # $tools is a validated, space-separated list
exec uvx "$PIN" --tools $tools --single-user
