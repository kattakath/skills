#!/usr/bin/env node
/**
 * PostToolUse advisory for Bash commands that measure SILENTLY — commands that will
 * exit 0 having measured nothing, or the wrong thing, so their output looks like
 * evidence and is not. Each rule names its catalogue entry
 * (skills/silent-instruments/references/catalogue.md) so the advice is traceable to a
 * measurement rather than to an opinion.
 *
 * WHY PostToolUse AND NOT PreToolUse — this is the load-bearing design decision, and
 * it is a security one. PreToolUse cannot advise without taking a permission
 * decision: the documented `permissionDecision: "allow"` means "tool call proceeds
 * WITHOUT permission prompt", so a globally-enabled plugin hook that used it would
 * bypass the user's own permission rules on every command it matched. `"deny"` blocks
 * legitimate work and `"ask"` adds a prompt to every match. PostToolUse has NO
 * permission authority at all — the tool has already run — so it cannot widen anything.
 *
 * It is also the better moment on the merits. These are not dangerous commands; they
 * are outputs about to be misread. PostToolUse fires between execution and
 * interpretation, which is exactly where the misreading happens.
 *
 * OUTPUT CHANNEL: always exit 0. A finding goes out as stdout JSON
 * `hookSpecificOutput.additionalContext`, which the hooks reference documents as the
 * PostToolUse way to put text "next to the tool result" as a system reminder
 * (https://code.claude.com/docs/en/hooks). The earlier exit-2-plus-stderr form also
 * reached Claude, but the UI labels every exit 2 "hook returned blocking error" — an
 * alarm on what is advice, which is exactly the noise that trains a reader to ignore
 * the channel. Anything that goes wrong also exits 0: an advisory must never wedge a turn.
 *
 * FALSE POSITIVES ARE THE REAL RISK. This hook is enabled globally, so a noisy rule
 * is worse than a missing one: advice that fires on ordinary work gets ignored, and an
 * ignored channel protects nothing. Every rule below is therefore shaped to the exact
 * construct that was measured, not to the general topic — and `tests/lint-cases.sh`
 * asserts the must-stay-QUIET half as carefully as the must-FLAG half.
 */

"use strict";

// ── shell helpers for the gh rules (C5, C11): quote-aware, never throw past test() ──

// Words, quoted strings and separators, so a `|` or `;` inside a quoted jq program
// does not split the gh invocation it belongs to.
const TOKEN =
  /'[^']*'|"(?:\\.|[^"\\])*"|\|\||&&|[|;\n()]|[^\s'"|;&()]+(?:'[^']*'|"(?:\\.|[^"\\])*"|[^\s'"|;&()]+)*/g;
const SEPARATOR = /^(?:\|\||&&|[|;\n()])$/;

function unquote(t) {
  return /^(['"]).*\1$/s.test(t) ? t.slice(1, -1) : t;
}

// Each gh invocation as its token list (from the `gh` word to the next separator).
function ghInvocations(c) {
  const out = [];
  let cur = null;
  for (const t of c.match(TOKEN) || []) {
    if (SEPARATOR.test(t)) {
      if (cur) out.push(cur);
      cur = null;
    } else if (cur) {
      cur.push(t);
    } else if (t === "gh") {
      cur = [];
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Value of a flag in a token list: `--flag X` or `--flag=X`.
function flagValue(args, names) {
  for (let i = 0; i < args.length; i++) {
    for (const n of names) {
      if (args[i] === n && i + 1 < args.length) return unquote(args[i + 1]);
      if (args[i].startsWith(n + "=")) return unquote(args[i].slice(n.length + 1));
    }
  }
  return null;
}

const GH_API_VALUE_FLAGS = new Set([
  "-q", "--jq", "-H", "--header", "-f", "--raw-field", "-F", "--field", "-X", "--method",
  "-t", "--template", "--hostname", "-p", "--preview", "--input", "--cache",
]);

// Endpoints of the `gh api` READS that could be lists: skips --paginate/--slurp,
// graphql and any non-GET method.
function ghApiEndpoints(c) {
  const out = [];
  for (const inv of ghInvocations(c)) {
    if (inv[0] !== "api") continue;
    const args = inv.slice(1);
    if (args.some((a) => a === "--paginate" || a === "--slurp")) continue;
    const method = flagValue(args, ["-X", "--method"]);
    if (method && method.toUpperCase() !== "GET") continue;
    let endpoint = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (GH_API_VALUE_FLAGS.has(a)) { i++; continue; }
      if (a.startsWith("-")) continue;
      endpoint = unquote(a);
      break;
    }
    if (endpoint && endpoint !== "graphql") out.push(endpoint);
  }
  return out;
}

// A path whose last segment is an id, a sha or a blob leaf names ONE resource.
function isListEndpoint(ep) {
  const segs = ep.split("?")[0].replace(/\/+$/, "").split("/").filter(Boolean);
  const last = segs[segs.length - 1] || "";
  if (/^\d+$/.test(last) || /^[0-9a-f]{7,40}$/i.test(last)) return false;
  if (/^(?:logs|zipball|tarball|readme|raw|diff|patch)$/i.test(last)) return false;
  if (segs[0] === "repos" && segs.length === 3) return false; // repos/{owner}/{repo}
  return true;
}

// The gh invocations that filter with --jq: their --json list (if any) and program.
function ghJqSegments(c) {
  const out = [];
  for (const inv of ghInvocations(c)) {
    const jq = flagValue(inv, ["--jq"]); // --jq only: the rule never read -q, so no new firings
    if (jq === null) continue;
    out.push({ json: inv[0] === "api" ? null : flagValue(inv, ["--json"]), jq });
  }
  return out;
}

// True only when every path in the jq program is a bare top-level field gh was asked
// for with --json: nested paths (`.a.b`), indexing (`.[0]`, `.x[0]`) and fields not
// in the list all return false, because gh validates none of those.
function jqPathsCoveredByJson(seg) {
  if (!seg.json) return false;
  const fields = new Set(seg.json.split(",").map((f) => f.trim()).filter(Boolean));
  if (/(?:^|[^\w\]).])\.\[/.test(seg.jq)) return false;
  const path = /(^|[^\w\]).])\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = path.exec(seg.jq)) !== null) {
    const after = seg.jq.slice(path.lastIndex);
    if (/^(?:\.[A-Za-z_\[]|\[)/.test(after)) return false;
    if (!fields.has(m[2])) return false;
  }
  return true;
}

const RULES = [
  {
    id: "A16",
    // `for x in $list` — unquoted, and not a glob. In zsh (the default shell on
    // macOS) an unquoted parameter is NOT field-split, so this iterates ONCE over the
    // whole value and exits 0. Excludes "$list" (correct) and $list* (a glob).
    // The list must be the bare parameter ALONE (then `;`, newline or `do`): in
    // `for f in $D/a.json $D/b.json` each word is one item already, so not splitting
    // it is correct — that literal-word form fired on real work (2026-10-27).
    test: (c) => /\bfor\s+[A-Za-z_][A-Za-z0-9_]*\s+in\s+\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)[ \t]*(?:;|\n|do\b)/.test(c),
    say: "`for x in $var` is not field-split in zsh, so it iterates ONCE over the whole value and exits 0 — the loop can do nothing and still look successful. Use `while IFS= read -r x; do …; done < <(producer)`, and cross-check the loop's count against an independent one.",
  },
  {
    id: "A6",
    test: (c) => /\$\{PIPESTATUS\[/.test(c) && !/set\s+-o\s+pipefail|set\s+-[a-z]*o\s+pipefail/.test(c),
    say: "`${PIPESTATUS[...]}` lies two different ways, and neither announces itself. In bash it is rewritten by the next command, so a stale read returns the INTERVENING command's status — usually 0, i.e. it reads as SUCCESS. In zsh there is no `PIPESTATUS` at all (it is `pipestatus`) and arrays are 1-indexed, so `[0]` is always empty. Prefer `set -o pipefail`; if you must read it, next line only, and `${pipestatus[1]}` in zsh.",
  },
  {
    id: "A4",
    // A pipeline whose status is then tested, without pipefail: the test sees only
    // the LAST stage. Shaped narrowly: an explicit `$?` read after a pipe.
    test: (c) => /\|/.test(c) && /\$\?/.test(c) && !/pipefail/.test(c) && !/\$\{PIPESTATUS\[/.test(c),
    say: "Without `set -o pipefail` a pipeline's `$?` is the LAST stage's status only, so a failing producer reads as success. Add `set -o pipefail` — and note `${PIPESTATUS[0]}` is NOT a safe substitute in zsh, where that index does not exist.",
  },
  {
    id: "A21",
    test: (c) => /\bps\s+(?:aux|-ef|ax)\b[^|]*\|\s*grep/.test(c),
    say: "`ps … | grep name` matches its own grep, so it can never report 'not running' — measured: a count of 3 for a process that did not exist. Use `pgrep -x name` (exit 1, no output, when absent).",
  },
  {
    id: "A20",
    test: (c) => /\bcurl\b/.test(c) && /(?:^|\s)-[a-zA-Z]*s/.test(c) && !/(?:^|\s)-[a-zA-Z]*f|--fail/.test(c),
    say: "`curl -s` exits 0 on HTTP 404/500 and hands you the error body, so a piped `jq` returns a clean empty answer from an error page. Use `curl -fsS`, or capture `-w '%{http_code}'` and branch on it.",
  },
  {
    id: "A10",
    test: (c) => /\bfind\b[^|]*-exec\b/.test(c),
    say: "`find … -exec cmd \\;` does NOT propagate the command's status — measured: `-exec false {} \\;` exits 0. Pipe through `xargs -0 -r` (which does propagate), or loop with `|| exit 1`.",
  },
  {
    id: "A1",
    test: (c) => /\b(?:local|export|declare|readonly)\s+[A-Za-z_][A-Za-z0-9_]*=\$\(/.test(c),
    say: "`local`/`export`/`declare` return THEIR own status, always 0, so the command substitution's failure vanishes and `set -e` never fires (ShellCheck SC2155). Declare and assign on separate lines.",
  },
  {
    id: "A14",
    test: (c) => /\bwc\s+-l\b/.test(c),
    say: "`wc -l` counts newlines, so a file whose last line has no trailing newline is undercounted by one — silently. `grep -c ''` counts lines. The same shape makes a `while read` loop drop the final item unless you add `|| [ -n \"$line\" ]`.",
  },
  {
    id: "B4",
    test: (c) => /merge-base\s+--is-ancestor|\bbranch\s+--merged\b/.test(c),
    say: "Ancestry answers 'is this commit OBJECT reachable', so squash, rebase and cherry-pick all make it say 'not merged' for work that IS merged. Use content — `git cherry <upstream> <branch>` or `git diff --quiet` on the paths — or ask the authority: `gh pr view --json state,mergedAt`.",
  },
  {
    id: "B5",
    test: (c) => /\bgit\s+diff\s+--quiet\b/.test(c),
    say: "`git diff --quiet` is BLIND to untracked files, so it reports a clean tree when a brand-new file is present — and flakes ignore untracked files, which is how an eval passes over a file git cannot see. Use `[ -z \"$(git status --porcelain)\" ]`.",
  },
  {
    id: "B1",
    test: (c) => /\bgit\s+checkout\s+--\s/.test(c),
    say: "`git checkout -- <path>` restores from the INDEX, not from HEAD, so it PRESERVES a staged mistake and discards only the unstaged part. Name the source: `git checkout HEAD -- <path>`.",
  },
  {
    id: "C5",
    // Only a LIST read truncates. An endpoint ending in an id (`check-runs/123`,
    // `comments/6438749595`), a sha, or a non-JSON leaf (`/logs`) returns one object
    // or a blob — those were most of this rule's firings on real work (2026-10-27).
    test: (c) => ghApiEndpoints(c).some(isListEndpoint),
    say: "REST list endpoints truncate at 30 (max 100) with NO marker in the body — a complete-looking array, HTTP 200. Use `gh api --paginate`, and treat `length == per_page` as 'assume truncated'.",
  },
  {
    id: "C11",
    // `gh <cmd> --json a,b --jq …` is safe ONLY when every path is a bare top-level
    // field from the --json list: gh rejects an unknown --json field (exit 1) and emits
    // every requested one. A jq typo is NOT caught — measured 2026-10-27:
    // `--json state --jq .stat` printed nothing and exited 0 — so anything else flags.
    test: (c) => ghJqSegments(c).some((s) => !jqPathsCoveredByJson(s)) || /\|\s*jq\s+(?!-e\b)-r\b/.test(c),
    say: "A wrong or renamed `jq` path yields `null`, not an error, and passes through as exit 0 — absent, null and 'my path was wrong' are indistinguishable. Use `jq -e` for scalars, or assert the shape with `has(\"field\")`.",
  },
  {
    id: "D2",
    // Forcing the sandbox on without forcing a rebuild. On an already-built
    // derivation Nix returns the cached store path, so the flag changes nothing and
    // the answer handed back is the one the UNSANDBOXED build produced — exit 0, zero
    // bytes on stderr. Narrow by construction: nobody types this flag by accident,
    // and `--option sandbox false` (the darwin default) is deliberately not matched.
    test: (c) => /--option\s+sandbox\s+(?:true|relaxed)\b/.test(c) && !/--rebuild\b|--check\b/.test(c),
    say: "`--option sandbox true` changes NOTHING on an already-built derivation — Nix returns the cached store path: exit 0, 0 bytes on stderr, carrying the result the UNSANDBOXED build produced (`sandbox` defaults to false on darwin, true on Linux). Add `--rebuild`, or change the derivation so its name is fresh. Expect `--rebuild` to be loud in two ways of its own, neither of which means your check is broken: 'are not valid, so checking is not possible' on a never-built drv, and 'may not be deterministic' when the builder tolerates losing the network.",
  },
];

// NO RULE FOR D1 (a declared-but-never-consumed config list), deliberately. Its trap
// lives in an Edit to a `.nix` file, and this hook gates on `tool_name === "Bash"`;
// widening that gate would make a globally-enabled hook inspect every file edit in
// every repo in order to catch one repo's option schema. Noise is worse than a gap —
// D1 stays prose in the catalogue.

function main() {
  let raw = "";
  try {
    raw = require("fs").readFileSync(0, "utf8");
  } catch {
    process.exit(0); // no stdin — nothing to inspect
  }
  if (!raw.trim()) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // never throw on a malformed payload: a throw disarms silently
  }

  const name = payload && payload.tool_name;
  if (name !== "Bash") process.exit(0);

  const input = (payload && payload.tool_input) || {};
  const cmd = typeof input.command === "string" ? input.command : "";
  if (!cmd.trim()) process.exit(0);

  const hits = [];
  for (const r of RULES) {
    let fired = false;
    try {
      fired = r.test(cmd);
    } catch {
      fired = false; // a broken rule must not take the others down
    }
    if (fired) hits.push(r);
  }
  if (hits.length === 0) process.exit(0);

  const lines = [
    "silent-instruments: this command can exit 0 having measured nothing.",
    "",
  ];
  for (const h of hits) lines.push(`  [${h.id}] ${h.say}`);
  lines.push("");
  lines.push(
    "Before this output becomes a claim, cross-check it with a DIFFERENTLY SHAPED",
  );
  lines.push(
    "instrument — one that could disagree. Full entries, with the measurements and",
  );
  lines.push("primary sources: the skill's references/catalogue.md.");

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: lines.join("\n"),
      },
    }) + "\n",
  );
  process.exit(0); // advice, not an error: reverts nothing, blocks nothing
}

try {
  main();
} catch {
  process.exit(0); // an advisory must never wedge a turn
}
