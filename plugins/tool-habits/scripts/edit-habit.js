#!/usr/bin/env node
// @ts-check
/**
 * edit-habit: a PreToolUse(Bash) adapter that ADVISES (never blocks) when a Bash command edits an
 * EXISTING file in place: `sed -i` / `perl -pi`, or an inline Python body that reads a file and
 * writes it back. The Edit tool does the same job with a reviewable diff and a permission scope.
 *
 * Advice, not a deny (operator decision, 2026-11-28), because it is common and partly endorsed:
 *   - measured: 4,866 hits in 55,639 Bash calls (8.7%) across 1,155 local transcripts, counts
 *     only; a hand-checked sample of an earlier draft was about 13 in 15 real edits (an estimate);
 *   - Claude Code's own bypass-mode system prompt tells agents to make "small, mechanical file
 *     changes with sed, heredocs, or short scripts". A deny would fight that on 1 call in 11.
 * Writing a NEW file is not flagged, nor is anything whose every path is a temp/scratch path.
 *
 * Contract (nix-dev-toolkit references/cli-contract.md): a finding prints ONE stdout JSON with
 * hookSpecificOutput.additionalContext and NO permissionDecision, exit 0; anything else prints
 * nothing, exit 0. It never exits 2 and never rewrites the command.
 */
"use strict";

const fs = require("node:fs");

const SED_ADVICE =
  "edit-habit: this edits an existing file in place from Bash (sed -i / perl -i). Prefer the Edit tool for file edits: it shows a reviewable diff and is permission-scoped. A new file, or one under a temp/scratch dir, is fine from Bash.";
const PY_ADVICE =
  "edit-habit: this inline Python reads a file and writes it back. Prefer the Edit tool for file edits (a reviewable diff, permission-scoped). For a generated file, keep the generator in a script file and run it by path.";

/** A temp or scratch path: throwaway, so not a reviewed edit. */
const SCRATCH =
  /^(\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\/dev\/|\$TMPDIR|\$\{TMPDIR|\$CLAUDE_JOB_DIR|\$\{CLAUDE_JOB_DIR|\$S\/|\$\{S\}\/|\$T\/|\$\{T\}\/)|\/jobs\/[^/]+\/tmp\/|scratchpad/;
/** @param {string} p */
const scratch = (p) => SCRATCH.test(p.replace(/^["']|["']$/g, ""));

/**
 * The file operands of `sed -i` / `perl -i…` in one segment's words, or null if there is none.
 * @param {string[]} w
 * @returns {string[] | null}
 */
function inplaceTargets(w) {
  const i = w.findIndex((x) => x === "sed" || x === "gsed" || x.endsWith("/sed") || x === "perl");
  if (i < 0) return null;
  const perl = w[i] === "perl";
  const rest = w.slice(i + 1);
  const flagged = rest.some((a) => (perl ? /^-[a-zA-Z]*i/.test(a) : /^(-i|--in-place)/.test(a) || /^-[nrsE]+i/.test(a)));
  if (!flagged) return null;
  const ops = [];
  let script = false;
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k];
    if (a.startsWith("-")) {
      if (a === "-e" || a === "-f") {
        k++;
        script = true;
      } else if (!perl && /^-[a-zA-Z]*i$/.test(a) && /^(''|"")$/.test(rest[k + 1] || "")) {
        k++; // BSD sed: `-i ''` takes an empty backup suffix as its own word
      }
      continue;
    }
    if (!script) {
      script = true;
      continue;
    }
    ops.push(a);
  }
  return ops;
}

/**
 * Inline Python (`-c` or a heredoc) that both reads a file and writes one.
 * @param {string} cmd
 */
function pythonReadModifyWrite(cmd) {
  if (!/\bpython3?\b/.test(cmd)) return false;
  const inline = /\bpython3?\b[^\n|;&]*\s-c\s/.test(cmd) || /\bpython3?\b[^\n|;&]*<</.test(cmd);
  if (!inline) return false;
  const reads = /\.read_text\(|open\([^)]*\)\.read\(\)|\.read\(\)|json\.load\(open\(/.test(cmd);
  const writes = /\.write_text\(|open\([^)]*,\s*["'](w|r\+)["'][^)]*\)\.write\(|open\([^)]*,\s*["'](w|r\+)["']/.test(cmd);
  if (!(reads && writes)) return false;
  const paths = cmd.match(/["'](\/[^"'\s]+|\$[A-Za-z_{][^"'\s]*)["']/g) || [];
  if (paths.length > 0 && paths.every(scratch)) return false;
  return true;
}

/**
 * @param {string} cmd
 * @returns {string | null} the advice, or null
 */
function classify(cmd) {
  if (!cmd) return null;
  for (const seg of cmd.split(/&&|\|\||;|\||\n/)) {
    const ops = inplaceTargets(seg.trim().split(/\s+/).filter(Boolean));
    if (ops && ops.some((p) => !scratch(p))) return SED_ADVICE;
  }
  return pythonReadModifyWrite(cmd) ? PY_ADVICE : null;
}

function hook() {
  let evt;
  try {
    evt = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const advice = classify(String(((evt && evt.tool_input) || {}).command || ""));
  if (!advice) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: advice } }) + "\n");
}

if (require.main === module) {
  try {
    hook();
  } catch {
    // An adapter bug must never block a call: no output, exit 0.
  }
  process.exit(0);
}
module.exports = { classify };
