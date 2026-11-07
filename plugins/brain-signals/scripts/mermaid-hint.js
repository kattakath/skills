#!/usr/bin/env node
// @ts-check
// SessionStart: if the `mermaid-ascii` CLI the diagram rules rely on is not on PATH,
// say so once — to the user (systemMessage) and to the model (additionalContext, so it
// falls back to hand-drawn ASCII instead of failing a Bash call). Silent when present.
//
// Why a hint and not a bundled binary: a plugin `bin/` directory makes claude.ai and
// Cowork refuse to install the plugin (code.claude.com/docs/en/plugins-reference), and
// upstream ships per-platform builds. The dependency stays external and visible.
"use strict";
const fs = require("fs");
const path = require("path");

// Types only — erased at run time, so the hook still needs nothing but `node`. They come
// from Anthropic's own SDK (CI installs it as a dev dependency and runs tsc over this file).
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SyncHookJSONOutput} SyncHookJSONOutput */

const TOOL = "mermaid-ascii";

/**
 * @param {string} name
 * @param {string | undefined} envPath
 * @param {string | undefined} pathExt
 */
function onPath(name, envPath, pathExt) {
  const exts = process.platform === "win32" ? (pathExt || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (envPath || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, name + ext), fs.constants.X_OK);
        return true;
      } catch {
        /* not here */
      }
    }
  }
  return false;
}

try {
  if (onPath(TOOL, process.env.PATH, process.env.PATHEXT)) process.exit(0);
  const install =
    "install it from https://github.com/AlexanderGrooff/mermaid-ascii/releases, " +
    "`go install github.com/AlexanderGrooff/mermaid-ascii@latest`, or " +
    "`nix run github:AlexanderGrooff/mermaid-ascii`";
  /** @type {SyncHookJSONOutput} */
  const out = {
    systemMessage: `brain-signals: \`${TOOL}\` is not on PATH, so diagrams fall back to hand-drawn ASCII — ${install}.`,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext:
        `\`${TOOL}\` is NOT installed in this environment. When a diagram helps, hand-draw it ` +
        "in box-drawing ASCII (still <=80 columns, plain --> edges only) instead of piping " +
        `mermaid source through \`${TOOL}\`; never show raw mermaid code.`,
    },
  };
  process.stdout.write(JSON.stringify(out));
} catch {
  /* a SessionStart hint must never wedge a session */
}
process.exitCode = 0;
