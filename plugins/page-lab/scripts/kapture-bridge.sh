#!/bin/sh
# Kapture bridge launcher — OFF unless the operator opts in with PAGE_LAB_KAPTURE=1.
#
# WHY GATED. kapture-mcp's bridge listens on 127.0.0.1:61822, and kapture-mcp@2.6.1's
# dist/origin-policy.js admits requests that carry NO Origin header plus one third-party web
# origin, while its /assistants endpoints write MCP client config files
# (docs/page-lab-vnext-design.md §2, §10). Always-loaded, that is a local listener any
# process can reach for as long as any session runs. Its only job here is the supervised
# pick tiers 2/3 (references/routes.md), which an operator starts on purpose — so it loads
# on purpose too.
#
# Disabled is exit 0 with ONE stderr line: the session simply has no kapture tools, and the
# line names why. (How the client labels a server that exits before its handshake is not
# measured.)
set -eu

case "${PAGE_LAB_KAPTURE:-0}" in
  1 | true | yes) exec npx -y kapture-mcp@2.6.1 bridge ;;
esac
printf '%s\n' 'kapture disabled: set PAGE_LAB_KAPTURE=1 for supervised pick tiers 2/3' >&2
exit 0
