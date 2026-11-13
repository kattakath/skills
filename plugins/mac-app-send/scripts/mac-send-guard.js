#!/usr/bin/env node
/**
 * PreToolUse guard for macOS computer-use automation.
 *
 * Each rule catches a move that was MEASURED to cost a turn, asks the operator to
 * confirm it, and names the move that works. The point is to spend zero inference
 * rediscovering any of them.
 *
 * Rule 1 — osascript/cliclick input injection.
 *   When an `app_*` tool refuses a target, its refusal says verbatim: "Do not
 *   attempt to work around this restriction — never use AppleScript, System
 *   Events, shell commands, or any other method to send clicks or keystrokes to
 *   this app." This rule makes that mechanical. It matches ONLY input injection
 *   (System Events + keystroke/click), so reading a property with osascript, and
 *   the sanctioned macos-automator MCP, both stay allowed. It matches a RUN
 *   osascript/cliclick, never the words as data (a grep pattern, a printf body).
 *
 * Rule 2 — multi-line app_type without element_index.
 *   `app_type` targeted by COORDINATE delivers raw keystrokes. In chat apps Enter
 *   sends, so a multi-line message arrives as one bubble per line and cannot be
 *   recalled. Targeting by `element_index` (or `target`) sets AXValue as a
 *   whole-field replace and the newlines survive.
 *
 * Rule 3 — request_access on the Open/Save panel service.
 *   `com.apple.appkit.xpc.openAndSavePanelService` is not an installed app, so
 *   the call returns `notInstalled`, is short-circuited, and is NEVER shown to
 *   the user. It can never be granted. The way through is display-scope control,
 *   which is a different consent surface the user approves themselves.
 *
 * Contract: hook JSON on stdin. A match prints ONE line of hook JSON on stdout,
 * permissionDecision "ask", and exits 0: the operator gets a confirm prompt whose
 * reason is also what Claude reads if the call is declined or nobody is present,
 * so the reason is one line, verdict first, then the better route. No match:
 * exit 0 with no output. An unexpected error, or nesting too deep to parse, asks when
 * the raw text is dangerous (cliclick, or osascript with an input verb) and otherwise
 * exits 0 with no output — a guard that throws must not wedge a turn. That fail-open is also why tests assert the
 * must-ALLOW half: a guard that silently matches nothing is not a weak guard, it
 * is NO guard.
 */

const fs = require("node:fs");

// System Events input injection. Requires osascript RUN AS A COMMAND with an
// input verb in its own arguments or heredoc — `osascript -e 'tell app "Finder"
// to get name'` is not injection. cliclick run as a command always is: synthesising
// input is all it does. The words appearing as DATA do not count: measured
// 2026-11-07, 21 of 80 prompts were false positives from a grep pattern, a printf
// body or an echo that merely contained "osascript" and "System Events".
const INJECTOR = /^(osascript|cliclick)$/i;
const INPUT_VERB = /\b(keystroke|key code|click at|perform action|System Events)\b/i;
const SHELLS = /^(ba|z|da|k)?sh$/;

// Splits a shell command into simple commands, quote-aware, without running it.
// Each command is { words, text, heredocs }: `words` are its unquoted-value words,
// `text` its raw source, `heredocs` the bodies fed to it. Command substitutions
// $( … ) and backticks open a nested command. Not a full shell parser — it only has
// to place the command word correctly, and an unparseable tail just ends a word.
function commands(src, depth = 0) {
  // FIX (ported from smtp-egress): bounded recursion; the caller treats the throw as "unsure".
  if (depth > MAX_DEPTH) throw new Error("nesting too deep");
  const out = [];
  let cur = null;
  const pendingHeredocs = [];
  const open = () => (cur = { words: [], text: "", heredocs: [] });
  const close = () => {
    if (cur && (cur.words.length || cur.text.trim())) out.push(cur);
    cur = null;
  };
  open();
  let word = null;
  const endWord = () => {
    if (word !== null) cur.words.push(word);
    word = null;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    cur.text += c;
    if (c === "#" && word === null) {
      // FIX (ported from smtp-egress): a comment runs to the end of the line and is never part of
      // a command (it used to become arguments, so the words of a comment could read as an input verb).
      let nl = src.indexOf("\n", i);
      if (nl === -1) nl = src.length;
      cur.text = cur.text.slice(0, -1);
      i = nl;
      continue;
    }
    if (c === "\\" && i + 1 < src.length) {
      word = (word ?? "") + src[i + 1];
      cur.text += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j === -1 ? src.length : j;
      word = (word ?? "") + src.slice(i + 1, end);
      cur.text += src.slice(i + 1, end + 1);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      // A double-quoted string may hold $( … ) commands; scan them recursively.
      let j = i + 1;
      let val = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) {
          val += src[j + 1];
          j += 2;
        } else if (src.startsWith("$(", j)) {
          const k = matchParen(src, j + 1);
          out.push(...commands(src.slice(j + 2, k), depth + 1));
          j = k + 1;
        } else if (src[j] === "`") {
          const k = src.indexOf("`", j + 1);
          const end = k === -1 ? src.length : k;
          out.push(...commands(src.slice(j + 1, end), depth + 1));
          j = end + 1;
        } else val += src[j++];
      }
      word = (word ?? "") + val;
      cur.text += src.slice(i + 1, j + 1);
      i = j + 1;
      continue;
    }
    if (src.startsWith("$(", i)) {
      const k = matchParen(src, i + 1);
      out.push(...commands(src.slice(i + 2, k), depth + 1));
      cur.text += src.slice(i + 1, k + 1);
      word = (word ?? "") + "$()";
      i = k + 1;
      continue;
    }
    if (c === "`") {
      const k = src.indexOf("`", i + 1);
      const end = k === -1 ? src.length : k;
      out.push(...commands(src.slice(i + 1, end), depth + 1));
      cur.text += src.slice(i + 1, end + 1);
      i = end + 1;
      continue;
    }
    if (src.startsWith("<<", i) && src[i + 2] !== "<") {
      endWord();
      let j = i + 2;
      if (src[j] === "-") j++;
      while (src[j] === " " || src[j] === "\t") j++;
      let k = j;
      while (k < src.length && !/[\s;&|<>()]/.test(src[k])) k++;
      const delim = src.slice(j, k).replace(/['"\\]/g, "");
      if (delim) pendingHeredocs.push({ delim, owner: cur });
      cur.text += src.slice(i + 1, k);
      i = k;
      continue;
    }
    if (c === "\n" && pendingHeredocs.length) {
      // Heredoc bodies follow the line that opened them; they are DATA for their
      // owner command, never commands of their own.
      endWord();
      let j = i + 1;
      for (const h of pendingHeredocs) {
        const lines = [];
        while (j < src.length) {
          let nl = src.indexOf("\n", j);
          if (nl === -1) nl = src.length;
          const line = src.slice(j, nl);
          j = nl + 1;
          if (line.replace(/^\t+/, "") === h.delim) break;
          lines.push(line);
        }
        h.owner.heredocs.push(lines.join("\n"));
      }
      pendingHeredocs.length = 0;
      close();
      open();
      i = j;
      continue;
    }
    if (/[;&|\n()]/.test(c)) {
      endWord();
      cur.text = cur.text.slice(0, -1);
      close();
      open();
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      endWord();
      i++;
      continue;
    }
    word = (word ?? "") + c;
    i++;
  }
  endWord();
  close();
  return out;
}

function matchParen(src, at) {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return i;
  }
  return src.length;
}

// Wrappers that run the rest of their words as a command. `v` = flags that take the next
// word as a value (so `sudo -u X cmd` runs cmd, not X); `pos` = positional words before
// the command (timeout's duration). FIX (ported from smtp-egress): the old version took
// the value of such a flag for the command word.
const WRAP = {
  sudo: { v: ["-u", "-g", "-h", "-p", "-C", "-U", "-r", "-t", "-T", "-D", "--user", "--group", "--host", "--prompt", "--close-from", "--other-user", "--role", "--type", "--command-timeout", "--chdir"] },
  doas: { v: ["-u", "-C"] },
  env: { v: ["-u", "--unset", "-C", "--chdir"] },
  exec: { v: ["-a"] },
  nohup: { v: [] },
  time: { v: ["-f", "--format", "-o", "--output"] },
  nice: { v: ["-n", "--adjustment"] },
  timeout: { v: ["-s", "--signal", "-k", "--kill-after"], pos: 1 },
  gtimeout: { v: ["-s", "--signal", "-k", "--kill-after"], pos: 1 },
  xargs: { v: ["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a", "--arg-file", "--delimiter", "--max-args", "--max-procs", "--replace", "--max-lines", "--eof"] },
  caffeinate: { v: ["-t", "-w"] },
  stdbuf: { v: ["-i", "-o", "-e"] },
};
for (const k of Object.keys(WRAP)) WRAP[k].v = new Set(WRAP[k].v);
const KEYWORDS = new Set(["{", "}", "!", "if", "then", "else", "elif", "do", "while", "until", "fi", "done"]);

// The word a simple command actually runs: skips VAR=value prefixes, shell keywords and
// wrappers (with their flag values), and takes the basename, so `sudo -u x /usr/bin/osascript`
// is osascript. Returns { word: "" } for `command -v X` (a lookup that runs nothing), and
// { evalText } for `eval …` / `env -S …`, whose argument is itself a command line.
function commandWord(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    const base = w.split("/").pop();
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || KEYWORDS.has(w)) { i++; continue; }
    if (base === "eval") return { word: "eval", rest: [], evalText: words.slice(i + 1).join(" ") };
    if (base === "command") {
      // FIX (ported): `command -v osascript` looks the name up; it never runs it.
      let j = i + 1;
      while (j < words.length && words[j].startsWith("-")) {
        if (/^-[a-zA-Z]*[vV]/.test(words[j])) return { word: "", rest: [] };
        j++;
      }
      i = j;
      continue;
    }
    const spec = WRAP[base];
    if (!spec) return { word: base, rest: words.slice(i + 1) };
    let j = i + 1, pos = spec.pos || 0;
    while (j < words.length) {
      const a = words[j];
      if ((base === "env" || base === "sudo") && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) { j++; continue; }
      if (a === "--") { j++; break; }
      if (spec.v.has(a)) { j += 2; continue; }
      if (base === "env" && (a === "-S" || a === "--split-string")) return { word: "eval", rest: [], evalText: words[j + 1] || "" };
      if (a.startsWith("-") && a.length > 1) { j++; continue; }
      if (pos > 0) { pos--; j++; continue; }
      break;
    }
    i = j;
  }
  return { word: "", rest: [] };
}

// A shell's own arguments: { cmd } for a -c string (any flag cluster containing c, so
// -lc/-ec count — FIX, ported), { script } for a script path, {} when it reads stdin.
function shellArgs(rest) {
  let c = false;
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (/^[-+][oO]$/.test(w) || w === "--rcfile" || w === "--init-file") { i++; continue; }
    if (w === "--") return pick(i + 1);
    if (/^--/.test(w)) continue;
    if (/^[-+][A-Za-z]+$/.test(w)) { if (w[0] === "-" && w.includes("c")) c = true; continue; }
    return pick(i);
  }
  return c ? { cmd: "" } : {};
  function pick(i) {
    if (i >= rest.length) return c ? { cmd: "" } : {};
    return c ? { cmd: rest[i] } : { script: rest[i] };
  }
}

class Unsure extends Error {}
const MAX_DEPTH = 64;
// The text-level danger pattern used only when parsing is unsure: cliclick anywhere, or
// osascript together with an input verb.
function danger(text) {
  return /\bcliclick\b/i.test(text) || (/\bosascript\b/i.test(text) && INPUT_VERB.test(text));
}

function injects(cmd, depth = 0) {
  // FIX (ported): this used to return false past depth 3, failing open.
  if (depth > MAX_DEPTH) throw new Unsure("depth");
  const all = commands(cmd);
  // A script written by a heredoc in the SAME call and then run by path
  // (`cat > s.applescript <<EOF … EOF; osascript s.applescript`) carries its verb
  // in another command's heredoc — seen in the 2026-11-07 replay — so any heredoc
  // in the call counts once osascript actually runs.
  const heredocs = all.flatMap((c) => c.heredocs);
  let stdinShell = false;
  for (const c of all) {
    const { word, rest, evalText } = commandWord(c.words);
    // FIX (ported): eval / env -S run their argument as a command line.
    if (evalText !== undefined) {
      if (injects(evalText, depth + 1)) return true;
      continue;
    }
    if (SHELLS.test(word)) {
      const sa = shellArgs(rest);
      if ("cmd" in sa) {
        if (injects(sa.cmd || "", depth + 1)) return true;
        continue;
      }
      if (c.heredocs.some((h) => injects(h, depth + 1))) return true;
      if (sa.script === undefined) stdinShell = true;
      continue;
    }
    if (!INJECTOR.test(word)) continue;
    if (/^cliclick$/i.test(word)) return true;
    if (INPUT_VERB.test([...rest, ...heredocs].join("\n"))) return true;
  }
  // FIX (ported): a shell reading stdin (`cat <<EOF | bash`, `echo … | sh`) runs what is
  // piped in. Scan every heredoc in the call, and ask if the call's text is dangerous at
  // all, since a pipe's content cannot be seen.
  if (stdinShell) {
    if (heredocs.some((h) => injects(h, depth + 1))) return true;
    if (danger(cmd)) return true;
  }
  return false;
}

const PANEL_SERVICE = /openAndSavePanelService/i;

// One line on stdout, written synchronously: process.stdout.write to a pipe is async on
// macOS and process.exit can truncate it, and an empty stdout reads as ALLOW.
function ask(reason) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: reason.replace(/\s+/g, " ").trim(),
    },
  };
  fs.writeSync(1, JSON.stringify(out) + "\n");
  process.exit(0);
}

const RULE1 =
  "mac-app-send: osascript/cliclick input injection works around a computer-use refusal that forbids it — prefer request_full_control then computer_batch (reading a value with osascript is fine). Allow anyway?";

let rawCmd = null;
try {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    process.exit(0);
  }
  if (!raw.trim()) process.exit(0);

  const ev = JSON.parse(raw);
  const tool = ev.tool_name || "";
  const input = ev.tool_input || {};

  // ── Rule 1 ────────────────────────────────────────────────────────────────
  if (tool === "Bash") {
    rawCmd = String(input.command || "");
    if (injects(rawCmd)) ask(RULE1);
  }

  // ── Rule 2 ────────────────────────────────────────────────────────────────
  if (/app_type$/.test(tool)) {
    const text = String(input.text ?? "");
    const targeted =
      input.element_index !== undefined && input.element_index !== null;
    const focused = input.target === "focused";
    if (text.includes("\n") && !targeted && !focused) {
      ask(
        "mac-app-send: multi-line app_type by coordinate sends raw keystrokes, so Enter sends one bubble per line — prefer app_ax_find role=AXTextArea then app_type element_index=N mode=replace, and screenshot the draft before Return. Allow anyway?"
      );
    }
  }

  // ── Rule 3 ────────────────────────────────────────────────────────────────
  if (/request_access$/.test(tool)) {
    const apps = Array.isArray(input.apps) ? input.apps : [];
    if (apps.some((a) => PANEL_SERVICE.test(String(a)))) {
      ask(
        "mac-app-send: request_access on openAndSavePanelService returns notInstalled, drops every other app in the call and is never shown to the user — prefer request_full_control then computer_batch, driving the panel's popups by keyboard. Allow anyway?"
      );
    }
  }

  process.exit(0);
} catch {
  // Never wedge a turn. FIX (ported): an Unsure (nesting too deep) or any parse error
  // asks when the raw Bash text is dangerous; only otherwise does it fail open.
  if (rawCmd !== null && danger(rawCmd)) ask(RULE1);
  process.exit(0);
}
