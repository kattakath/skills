#!/usr/bin/env bash
# Cases for scripts/mermaid-hint.js (SessionStart): silent when mermaid-ascii is on PATH,
# one hint (systemMessage + additionalContext) when it is not, exit 0 either way.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
hook="$here/../scripts/mermaid-hint.js"
node_bin="$(command -v node)"
pass=0 fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1 (got [$2], want [$3])"; fi; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/with" "$tmp/without" "$tmp/noexec"
printf '#!/bin/sh\n' > "$tmp/with/mermaid-ascii"; chmod +x "$tmp/with/mermaid-ascii"
printf '#!/bin/sh\n' > "$tmp/noexec/mermaid-ascii"; chmod -x "$tmp/noexec/mermaid-ascii"

out="$(echo '{}' | PATH="$tmp/with" "$node_bin" "$hook")"; rc=$?
check "present: exit 0" "$rc" "0"
check "present: no output" "$out" ""

out="$(echo '{}' | PATH="$tmp/without" "$node_bin" "$hook")"; rc=$?
check "absent: exit 0" "$rc" "0"
check "absent: systemMessage names the tool" \
  "$(printf '%s' "$out" | "$node_bin" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(/mermaid-ascii/.test(j.systemMessage))})')" "true"
check "absent: additionalContext for SessionStart" \
  "$(printf '%s' "$out" | "$node_bin" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.hookSpecificOutput.hookEventName+":"+(j.hookSpecificOutput.additionalContext.length>0))})')" "SessionStart:true"
check "absent: never blocks (no decision key)" \
  "$(printf '%s' "$out" | "$node_bin" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log("decision" in JSON.parse(s))})')" "false"

out="$(echo '{}' | PATH="$tmp/noexec" "$node_bin" "$hook")"; rc=$?
check "non-executable file does not count as installed" "$([ -n "$out" ] && echo hint || echo silent)" "hint"

out="$(echo '{}' | PATH="" "$node_bin" "$hook")"; rc=$?
check "empty PATH: exit 0" "$rc" "0"

echo "mermaid-hint cases: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
