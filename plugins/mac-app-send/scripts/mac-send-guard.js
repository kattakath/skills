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
 * exit 0 with no output. ANY unexpected error exits 0 with no output — a guard
 * that throws must not wedge a turn. That fail-open is also why tests assert the
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
// Words that run the NEXT word as the command. timeout/nice take one value first.
// Shell keywords that precede a command are skipped the same way.
const WRAPPERS = new Set([
  "sudo", "env", "exec", "nohup", "time", "command", "xargs", "caffeinate",
  "{", "!", "if", "then", "else", "elif", "do", "while", "until",
]);
const WRAPPERS_WITH_ARG = new Set(["timeout", "nice"]);
const SHELLS = /^(ba|z|da|k)?sh$/;

// Splits a shell command into simple commands, quote-aware, without running it.
// Each command is { words, text, heredocs }: `words` are its unquoted-value words,
// `text` its raw source, `heredocs` the bodies fed to it. Command substitutions
// $( … ) and backticks open a nested command. Not a full shell parser — it only has
// to place the command word correctly, and an unparseable tail just ends a word.
function commands(src) {
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
          out.push(...commands(src.slice(j + 2, k)));
          j = k + 1;
        } else if (src[j] === "`") {
          const k = src.indexOf("`", j + 1);
          const end = k === -1 ? src.length : k;
          out.push(...commands(src.slice(j + 1, end)));
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
      out.push(...commands(src.slice(i + 2, k)));
      cur.text += src.slice(i + 1, k + 1);
      word = (word ?? "") + "$()";
      i = k + 1;
      continue;
    }
    if (c === "`") {
      const k = src.indexOf("`", i + 1);
      const end = k === -1 ? src.length : k;
      out.push(...commands(src.slice(i + 1, end)));
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

// The word a simple command actually runs: skips VAR=value prefixes and wrappers,
// and takes the basename, so `sudo /usr/bin/osascript` is osascript.
function commandWord(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    const base = w.split("/").pop();
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || w.startsWith("-")) i++;
    else if (WRAPPERS.has(base)) i++;
    else if (WRAPPERS_WITH_ARG.has(base)) i += 2;
    else return { word: base, rest: words.slice(i + 1) };
  }
  return { word: "", rest: [] };
}

function injects(cmd, depth = 0) {
  if (depth > 3) return false;
  const all = commands(cmd);
  // A script written by a heredoc in the SAME call and then run by path
  // (`cat > s.applescript <<EOF … EOF; osascript s.applescript`) carries its verb
  // in another command's heredoc — seen in the 2026-11-07 replay — so any heredoc
  // in the call counts once osascript actually runs.
  const heredocs = all.flatMap((c) => c.heredocs);
  for (const c of all) {
    const { word, rest } = commandWord(c.words);
    if (SHELLS.test(word)) {
      const ci = rest.indexOf("-c");
      if (ci !== -1 && injects(rest[ci + 1] || "", depth + 1)) return true;
      if (c.heredocs.some((h) => injects(h, depth + 1))) return true;
      continue;
    }
    if (!INJECTOR.test(word)) continue;
    if (/^cliclick$/i.test(word)) return true;
    if (INPUT_VERB.test([...rest, ...heredocs].join("\n"))) return true;
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
    const cmd = String(input.command || "");
    if (injects(cmd)) {
      ask(
        "mac-app-send: osascript/cliclick input injection works around a computer-use refusal that forbids it — prefer request_full_control then computer_batch (reading a value with osascript is fine). Allow anyway?"
      );
    }
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
  // Never wedge a turn.
  process.exit(0);
}
