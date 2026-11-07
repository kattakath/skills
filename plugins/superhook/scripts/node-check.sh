#!/bin/sh
# SessionStart: say so, once, when `node` is not on PATH. Silent when it is.
#
# Why this is POSIX sh and not node: it exists for the session where node is missing.
# Every safety-floor hook runs `node` (superhook's wrappers, nix-flake-kit's PostToolUse
# pair, brain-signals' SessionStart and Stop hooks), and the Claude Code CLI is a native
# binary that does not ship one. Without node those hooks cannot start, and superhook's
# PreToolUse entry sets `onFailure: "block"`: a hook that "could not start" counts as
# exit 2 (the `onFailure` docs in the Agent SDK's sdk.d.ts), so every Bash call is
# blocked in a repo that has .claude/hooks/pretooluse-bash-guard.js. That is the
# fail-closed design working — but
# without this notice it looks like a broken session rather than a missing dependency.
#
# Builtins only (`command -v`, `printf`), so it runs even with an empty PATH. hooks.json
# starts it as /bin/sh by absolute path for the same reason. Always exits 0: a SessionStart
# hook that fails is reported as a hook error, not as this message.

command -v node >/dev/null 2>&1 && exit 0

printf '%s\n' '{"systemMessage":"superhook: node is not on PATH, so the safety-floor hooks (superhook guards, nix-flake-kit, brain-signals) cannot run. In a repo with .claude/hooks/pretooluse-bash-guard.js, superhook BLOCKS every Bash call (fail-closed) until node is installed. Install Node.js, put it on PATH and restart the session.","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"node is NOT on PATH in this environment. Plugin hooks that run node (superhook, nix-flake-kit, brain-signals) cannot start. Where .claude/hooks/pretooluse-bash-guard.js exists, superhook blocks every Bash call on purpose (fail-closed) until node is installed: do not retry or work around the block; tell the user to install Node.js and restart the session."}}'
exit 0
