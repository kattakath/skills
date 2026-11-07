#!/usr/bin/env node
// Stub inner hook for supervisor-cases.sh. argv[2] picks the verdict; stdin is
// read and ignored, like a real hook that only inspects the payload.
const mode = process.argv[2];
try { require("node:fs").readFileSync(0); } catch { /* no stdin */ }
const say = (o) => process.stdout.write(JSON.stringify(o));
switch (mode) {
  case "block": say({ decision: "block", reason: "stub: hard block" }); break;
  case "deny":
    say({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "stub: hard deny" } });
    break;
  case "ask":
    say({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "stub: confirm?" } });
    break;
  case "approve": say({ decision: "approve" }); break;
  case "exit2": process.stderr.write("stub: exit-2 block"); process.exitCode = 2; break;
  case "crash": throw new Error("stub: crashed");
  case "empty": break;
  case "plain": process.stdout.write("stub plain text"); break;
  default: process.exitCode = 3;
}
