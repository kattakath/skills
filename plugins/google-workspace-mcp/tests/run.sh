#!/usr/bin/env bash
# shellcheck disable=SC2015 # `has` is a pure test, so A && B || fail is safe here
# google-workspace-mcp launcher cases. A stub `uvx` records what the real one would get,
# so no network, no uv and no Google account are needed. Every case runs under `env -i`:
# an inherited GOOGLE_OAUTH_* (or a BASH_ENV that exports one) would fake a pass.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
launch="$(dirname "$here")/scripts/launch.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin" "$tmp/nouvx"
cat > "$tmp/bin/uvx" <<'EOF'
#!/bin/sh
{
  echo "argv=$*"
  echo "id=${GOOGLE_OAUTH_CLIENT_ID:-}"
  echo "secret=${GOOGLE_OAUTH_CLIENT_SECRET:-}"
  echo "email=${USER_GOOGLE_EMAIL-<unset>}"
  echo "gwm_left=${GWM_CLIENT_SECRET-}${GWM_CREDENTIAL_COMMAND-}${GWM_WRAPPED-}"
} > "$OUT"
EOF
# A credential command in the documented shape: a prefix that execs its arguments.
cat > "$tmp/bin/fake-cred" <<'EOF'
#!/bin/sh
GOOGLE_OAUTH_CLIENT_ID=from-cmd GOOGLE_OAUTH_CLIENT_SECRET=cmd-secret exec "$@"
EOF
chmod +x "$tmp/bin/uvx" "$tmp/bin/fake-cred"
base=("PATH=$tmp/bin:/usr/bin:/bin" "OUT=$tmp/out")

pass=0
fail() { echo "FAIL: $1" >&2; [ -f "$tmp/out" ] && sed 's/^/  /' "$tmp/out" >&2; exit 1; }
ok() { pass=$((pass + 1)); echo "ok   $1"; }
run() { rm -f "$tmp/out"; env -i "${base[@]}" "$@" sh "$launch" 2>"$tmp/err"; }
has() { grep -qx -- "$1" "$tmp/out"; }

run || true
grep -q 'no OAuth client' "$tmp/err" && [ ! -f "$tmp/out" ] || fail "no credentials must fail loud"
ok "no credentials: one actionable message, server not started"

run GWM_CLIENT_ID=uc-id GWM_CLIENT_SECRET=uc-secret GWM_TOOLS=tasks
has 'argv=workspace-mcp==2.2.1 --tools tasks --single-user' && has 'id=uc-id' && has 'secret=uc-secret' ||
  fail "userConfig fields"
ok "userConfig fields fill empty credentials; pinned spec; tasks only"

run GOOGLE_OAUTH_CLIENT_ID=env-id GOOGLE_OAUTH_CLIENT_SECRET=env-secret GWM_CLIENT_ID= GWM_CLIENT_SECRET=
has 'id=env-id' && has 'secret=env-secret' || fail "empty userConfig must not blank the environment"
ok "empty userConfig (the unset-value shape) keeps the inherited environment"

run GOOGLE_OAUTH_CLIENT_ID=env-id GOOGLE_OAUTH_CLIENT_SECRET=env-secret GWM_CLIENT_ID=uc-id GWM_CLIENT_SECRET=uc-secret
has 'id=env-id' || fail "environment must beat userConfig"
ok "environment beats userConfig"

run GOOGLE_OAUTH_CLIENT_ID=env-id GOOGLE_OAUTH_CLIENT_SECRET=env-secret GWM_CREDENTIAL_COMMAND=fake-cred
has 'id=from-cmd' && has 'secret=cmd-secret' || fail "credential command must win"
ok "credential command beats the environment"

run GWM_CREDENTIAL_COMMAND=fake-cred GWM_TOOLS=tasks,chat GWM_EMAIL=a@example.com
has 'argv=workspace-mcp==2.2.1 --tools tasks chat --single-user' && has 'email=a@example.com' && has 'gwm_left=' ||
  fail "tools list, email, GWM_* scrubbed"
ok "comma list becomes --tools args; email exported; GWM_* scrubbed from the server env"

run GWM_CLIENT_ID=i GWM_CLIENT_SECRET=s GWM_EMAIL=
has 'email=<unset>' || fail "empty email must leave USER_GOOGLE_EMAIL unset"
ok "empty email leaves USER_GOOGLE_EMAIL unset"

run GWM_CLIENT_ID=i GWM_CLIENT_SECRET=s GWM_TOOLS=
has 'argv=workspace-mcp==2.2.1 --tools tasks --single-user' || fail "empty tools must default to tasks"
ok "empty tools falls back to tasks"

run GWM_CLIENT_ID=i GWM_CLIENT_SECRET=s GWM_TOOLS=tasks,calender || true
grep -q "unknown service 'calender'" "$tmp/err" && [ ! -f "$tmp/out" ] || fail "typo must fail loud"
ok "unknown service fails loud before starting"

rm -f "$tmp/out"
env -i PATH="$tmp/nouvx:/usr/bin:/bin" GWM_CLIENT_ID=i GWM_CLIENT_SECRET=s sh "$launch" 2>"$tmp/err" || true
grep -q 'uvx not found' "$tmp/err" || fail "missing uvx must fail loud"
ok "missing uvx fails loud"

run GWM_CLIENT_ID=i GWM_CLIENT_SECRET=topsecret
grep '^argv=' "$tmp/out" | grep -q topsecret && fail "secret leaked into argv"
ok "secret never reaches argv"

# Floor: a renamed or emptied case list must not pass as a green no-op.
[ "$pass" -ge 11 ] || { echo "expected >= 11 cases, ran $pass" >&2; exit 1; }
echo "google-workspace-mcp: $pass cases passed"
