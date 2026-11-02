#!/usr/bin/env node
/**
 * staging-guard.js — PreToolUse(Bash) gate: never commit a real statement without a confirm.
 *
 * A QFX/OFX export carries the FULL account number in <ACCTID>; a real PDF or CSV statement
 * carries names, balances and counterparties. This plugin's fixtures are synthetic by rule
 * (see README § Privacy), so a real statement reaching a commit is always a mistake, and a
 * pushed commit is close to unrecoverable (history-scrub exists because it happens).
 *
 * It asks the operator to confirm a `git commit` (hook JSON on stdout, permissionDecision "ask",
 * exit 0) when what that commit would contain has:
 *   1. OFX content (an OFXHEADER: line or an <OFX> element, sniffed from the content, not
 *      the extension) or a .qfx/.ofx/.qbo file, outside a `fixtures/` directory — in ANY repo;
 *   2. a .pdf, .csv, .xlsx or .xls file inside `plugins/statement-extract/` outside `fixtures/`
 *      (and a .pdf there at all: PDF fixtures are text, *.layout.txt).
 *
 * "What the commit would contain" = the index, plus, for `git commit -a`/`--all`, modified
 * tracked files, plus the paths a `git add` earlier in the same command would stage (the
 * hook runs BEFORE that add, so the index alone would miss `git add x.qfx && git commit`).
 *
 * DELIBERATELY NARROW: it runs on every Bash call in every repo with the plugin enabled, so it
 * returns at once unless the command contains `git … commit`, it never inspects anything
 * else, and it never asks about a CSV or PDF outside this plugin.
 *
 * LIMITS: it reads command text. A commit made by a script, an alias, or another tool is
 * opaque to it. It is a floor under the skill's rule, not a sandbox.
 *
 * FAIL OPEN: a malformed payload or an internal error approves (exit 0, nothing on stdout) with
 * a note on stderr. A guard that threw and denied would stall every Bash call in every session.
 * tests/guard-cases.sh asserts both directions and the fail-open path.
 */
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const COMMIT_RE = /(?:^|[;&|(\n]|\$\()\s*(?:\S+=\S+\s+)*git((?:\s+-[Cc]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*)\s+commit\b([^;&|\n]*)/g;
const ADD_RE = /(?:^|[;&|(\n]|\$\()\s*(?:\S+=\S+\s+)*git((?:\s+-[Cc]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*)\s+add\b([^;&|\n]*)/g;
const OFX_EXT = /\.(qfx|ofx|qbo)$/i;
const PLUGIN_DIR = "plugins/statement-extract/";
const PLUGIN_BANNED = /\.(pdf|csv|xlsx|xls)$/i;
const SNIFF_BYTES = 4096;
const MAX_BLOB = 20 * 1024 * 1024;

function allow(note) {
  if (note) process.stderr.write(`statement-extract staging-guard: ${note}\n`);
  process.exit(0);
}

// ONE line of hook JSON on stdout, exit 0: the operator gets a confirm prompt, and the reason
// is also what Claude reads if the call is declined or nobody is present. Written with
// writeSync: process.stdout.write to a pipe is async on macOS and process.exit can truncate
// it, and an empty stdout reads as ALLOW.
function ask(lines) {
  const reason = (
    "statement-extract: this commit would add real statement data (" +
    lines.join("; ") +
    ") — fixtures must be synthetic and under fixtures/; unstage with git restore --staged <path> " +
    "and keep the statement out of the repo (e.g. Drive). Allow anyway?"
  )
    .replace(/\s+/g, " ")
    .trim();
  fs.writeSync(
    1,
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: reason,
      },
    }) + "\n"
  );
  process.exit(0);
}

function git(cwd, args, binary) {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    encoding: binary ? "buffer" : "utf8",
    maxBuffer: MAX_BLOB + 1024,
  });
  if (r.status !== 0) return null;
  return r.stdout;
}

function words(s) {
  // Shell-ish split good enough for flags and plain paths; quotes are stripped.
  return (s.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((w) => w.replace(/^['"]|['"]$/g, ""));
}

function repoDir(cwd, globalOpts) {
  let dir = cwd;
  const w = words(globalOpts);
  for (let i = 0; i < w.length; i++) {
    if (w[i] === "-C" && w[i + 1]) dir = path.resolve(dir, w[++i]);
    else if (w[i] === "-c") i++; // -c key=value: a config override, not a directory
  }
  return dir;
}

function inFixtures(p) {
  return /(^|\/)fixtures\//.test(p);
}

function sniffOfx(buf) {
  const head = buf.subarray(0, SNIFF_BYTES).toString("latin1");
  return /^\s*OFXHEADER:/m.test(head) || /<OFX>/i.test(head);
}

function problems(root, entries) {
  // entries: [{path, blob: () => Buffer|null}]
  const out = [];
  for (const e of entries) {
    const p = e.path;
    if (!inFixtures(p)) {
      if (OFX_EXT.test(p)) {
        out.push(`${p}: a QFX/OFX export outside fixtures/ (it carries the full account number)`);
        continue;
      }
      const buf = e.blob();
      if (buf && sniffOfx(buf)) {
        out.push(`${p}: OFX content outside fixtures/ (it carries the full account number)`);
        continue;
      }
    }
    if (p.includes(PLUGIN_DIR)) {
      if (/\.pdf$/i.test(p)) out.push(`${p}: a PDF in the statement-extract plugin (PDF fixtures are *.layout.txt)`);
      else if (PLUGIN_BANNED.test(p) && !inFixtures(p))
        out.push(`${p}: a statement-like file in the statement-extract plugin outside fixtures/`);
    }
  }
  return out;
}

function stagedEntries(root) {
  const raw = git(root, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]);
  if (raw === null) return null;
  return raw
    .split("\0")
    .filter(Boolean)
    .map((p) => ({
      path: p,
      blob: () => {
        const size = parseInt((git(root, ["cat-file", "-s", `:${p}`]) || "0").trim(), 10);
        if (!size || size > MAX_BLOB) return null;
        return git(root, ["cat-file", "blob", `:${p}`], true);
      },
    }));
}

function worktreeEntry(root, p) {
  return {
    path: p,
    blob: () => {
      try {
        const full = path.join(root, p);
        const st = fs.statSync(full);
        if (!st.isFile() || st.size > MAX_BLOB) return null;
        const fd = fs.openSync(full, "r");
        const buf = Buffer.alloc(Math.min(SNIFF_BYTES, st.size));
        fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        return buf;
      } catch (_) {
        return null;
      }
    },
  };
}

function changedPaths(root, which) {
  // which: "modified" (tracked, unstaged) | "all" (modified + untracked, not ignored)
  const args =
    which === "modified"
      ? ["diff", "--name-only", "-z", "--diff-filter=ACMR"]
      : ["ls-files", "-z", "--modified", "--others", "--exclude-standard"];
  const raw = git(root, args);
  return raw === null ? [] : raw.split("\0").filter(Boolean);
}

function addedPaths(root, addArgs) {
  const w = words(addArgs);
  const flags = w.filter((x) => x.startsWith("-"));
  const specs = w.filter((x) => !x.startsWith("-"));
  if (flags.some((f) => f === "-A" || f === "--all" || f === "-u" || f === "--update") || specs.includes("."))
    return changedPaths(root, flags.some((f) => f === "-u" || f === "--update") ? "modified" : "all");
  const all = changedPaths(root, "all");
  return all.filter((p) => specs.some((s) => p === s || p.startsWith(s.replace(/\/?$/, "/"))));
}

function main(payload) {
  const cmd = (payload && payload.tool_input && payload.tool_input.command) || "";
  if (typeof cmd !== "string" || !/\bgit\b[^\n]*\bcommit\b/.test(cmd)) return allow();
  const cwd = (payload && payload.cwd) || process.cwd();

  const found = [];
  const seen = new Set();
  let m;
  COMMIT_RE.lastIndex = 0;
  while ((m = COMMIT_RE.exec(cmd)) !== null) {
    const root = repoDir(cwd, m[1] || "");
    const top = git(root, ["rev-parse", "--show-toplevel"]);
    if (top === null) continue; // not a repo: git itself will fail the command
    const r = top.trim();
    const entries = stagedEntries(r) || [];
    const commitWords = words(m[2] || "");
    if (commitWords.some((x) => x === "-a" || x === "--all" || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(x)))
      for (const p of changedPaths(r, "modified")) entries.push(worktreeEntry(r, p));
    let a;
    ADD_RE.lastIndex = 0;
    while ((a = ADD_RE.exec(cmd)) !== null) {
      if (a.index > m.index) break;
      if (repoDir(cwd, a[1] || "") !== root) continue;
      for (const p of addedPaths(r, a[2] || "")) entries.push(worktreeEntry(r, p));
    }
    for (const msg of problems(r, entries)) if (!seen.has(msg)) (seen.add(msg), found.push(msg));
  }
  if (found.length) ask(found);
  allow();
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    return allow("malformed hook payload; not checking this command");
  }
  try {
    main(payload);
  } catch (e) {
    allow(`internal error (${e && e.name}); not checking this command`);
  }
});
