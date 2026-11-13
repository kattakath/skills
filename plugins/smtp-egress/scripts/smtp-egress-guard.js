#!/usr/bin/env node
/**
 * PreToolUse guard for smtp-egress: a human approves every email before it leaves.
 *
 * Design rule: ASK WHEN UNSURE. This guard can only ask, never deny, so a false ask
 * costs one click and a false allow lets an email leave with no human in the loop.
 * Every ambiguity therefore resolves to "ask".
 *
 * Rule 1 — the plugin's own scripts, wherever they live. Any command word, or any
 *   script argument of bash/sh/zsh/source/., whose basename is send.sh or
 *   header-check.sh asks. `$VAR/send.sh`, `./send.sh` and `cd … && ./send.sh` all count.
 *   Allowed: send.sh with a real --dry-run flag; header-check.sh with --headers <file>
 *   or a real --dry-run (its argument grammar is modelled exactly). The send prompt
 *   lists every To/Cc/Bcc recipient, the Subject and sha256[:12] of the .eml.
 *
 * Rule 2 — raw bypass shapes, which skip egress-check: msmtp run directly (not
 *   --version/--serverinfo/--help, not `command -v`/`which`), sendmail, swaks,
 *   mail/mailx/mutt with a recipient, curl smtp(s)://, python smtplib SMTP(/SMTP_SSL(,
 *   openssl s_client and nc/ncat/socat/telnet to :25/:465/:587. Wrappers are seen
 *   through (sudo -u X, timeout -s KILL 5, env, nice -n, xargs, nix … -c, find -exec),
 *   as are bash -lc/-ec strings, eval, and a heredoc or pipe into a shell on stdin.
 *
 * Words as DATA never ask: a grep pattern, a printf/echo body, a heredoc to a file.
 *
 * Unsure → ask: nesting past MAX_DEPTH, any parse exception, and the outer catch ask
 * when the raw command matches DANGER; only otherwise do they fail open.
 *
 * Contract: hook JSON on stdin. A match prints ONE line of hook JSON, permissionDecision
 * "ask", exit 0. No match: exit 0, no output.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_DEPTH = 64;
const DANGER = /\b(msmtp|sendmail|swaks|smtplib|send\.sh|header-check\.sh)\b|smtps?:\/\//i;

// ── Shell parser — copied from mac-app-send's mac-send-guard.js ─────────────────────
// Plugins install independently, so a shared module cannot be required across them.
// Two places differ from the original, each marked "FIX vs mac-app-send".
// Splits a shell command into simple commands, quote-aware, without running it.
// Each command is { words, text, heredocs }: `words` are its unquoted-value words,
// `text` its raw source, `heredocs` the bodies fed to it. Command substitutions
// $( … ) and backticks open a nested command. Not a full shell parser — it only has
// to place the command word correctly, and an unparseable tail just ends a word.
function commands(src, depth = 0) {
  // FIX vs mac-app-send: bounded recursion; the caller treats the throw as "unsure".
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
      // FIX vs mac-app-send: a comment runs to the end of the line and is never part of
      // a command (it used to become arguments, so `send.sh m.eml # --dry-run` read as dry).
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

// ── End of the copied parser ────────────────────────────────────────────────────────
// Below is new: mac-app-send's commandWord() mis-placed the command word behind
// value-taking wrapper flags (sudo -u X, timeout -s KILL 5, nice -n 5), ran
// `command -v X`, and matched a shell's -c only when spelled exactly "-c".

class Unsure extends Error {}

const base = (w) => String(w).split("/").pop();
const PLUGIN_SCRIPT = /^(send|header-check)\.sh$/;
const SHELL = /^(ba|z|da|k|mk|a)?sh$/;
const SMTP_PORT_WORD = /^(25|465|587)$/;
const SMTP_PORT_IN = /:(25|465|587)\b/;
const KEYWORDS = new Set(["{", "}", "!", "if", "then", "else", "elif", "do", "while", "until", "fi", "done"]);

// Wrappers that run the rest of their words as a command. `v` = flags taking the next
// word as a value; `pos` = positional words before the command (timeout's duration).
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
  nocorrect: { v: [] },
  builtin: { v: [] },
};
for (const k of Object.keys(WRAP)) WRAP[k].v = new Set(WRAP[k].v);

// Drop redirections (`> f`, `2>&1`, `<m.eml`) so a redirect target is never an argument.
function stripRedirects(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^(\d*|&)(>>?|<|<>|>\||<<<)$/.test(w)) { i++; continue; }
    if (/^(\d*|&)(>>?|<|<>|>\|)(&\d+|&-|\S+)$/.test(w)) continue;
    out.push(w);
  }
  return out;
}

// ── Rule 1 ─────────────────────────────────────────────────────────────────────────
function pluginRule(script, argv, ctx) {
  const args = stripRedirects(argv);
  if (base(script) === "send.sh") {
    // send.sh reads every argument as a flag or the .eml, so an exact --dry-run IS the flag.
    if (args.includes("--dry-run")) return null;
    return sendReason(args, ctx.cwd);
  }
  // header-check.sh: the same grammar as the script's own argument loop.
  let dry = false, headers = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") dry = true;
    else if (a === "--headers") headers = args[++i] ?? "";
    else if (a === "--direct-v4" || a === "--direct-v6" || a === "--from-domain") i++;
    else return HC_REASON; // -h, unknown flags, stray words: unsure
  }
  if (dry || (headers && !headers.startsWith("-"))) return null;
  return HC_REASON;
}
const HC_REASON =
  "smtp-egress: header-check sends a REAL probe email to PROBE_RECIPIENT through send.sh (egress-check runs inside it, after approval). Approve this send?";

// Addresses in a header value: the addr-spec of each mailbox, display names dropped.
function addrs(v) {
  return (v.match(/[^\s<>,;:"()]+@[^\s<>,;:"()]+/g) || []).map((a) => a.toLowerCase());
}
function cap(s, n) {
  return s.length > n ? s.slice(0, n - 3) + "..." : s;
}
// "To: a, b | Cc: c | Bcc: d", every recipient, capped near 300 chars with "+N more".
function recipientList(groups) {
  const all = groups.flatMap(([label, list]) => list.map((a) => [label, a]));
  if (!all.length) return "Recipients: (none found)";
  let out = "", shown = 0, last = "";
  for (const [label, a] of all) {
    const piece = (label !== last ? (out ? " | " : "") + label + ": " : ", ") + a;
    if ((out + piece).length > 300) break;
    out += piece; last = label; shown++;
  }
  return out + (shown < all.length ? ` (+${all.length - shown} more)` : "");
}

function emlSummary(p, cwd) {
  try {
    if (!p || /\$/.test(p)) return null; // unexpanded variable: cannot know the file
    const abs = path.resolve(cwd || process.cwd(), p.replace(/^~(?=\/)/, process.env.HOME || "~"));
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > 1024 * 1024) return null;
    const buf = fs.readFileSync(abs);
    const sha = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 12);
    const text = buf.toString("utf8");
    const end = text.search(/\r?\n\r?\n/);
    const head = (end === -1 ? text : text.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
    const all = (name) =>
      [...head.matchAll(new RegExp("^" + name + ":[ \\t]*(.*)$", "gim"))].map((m) => m[1].trim()).join(", ");
    const note = all("Message-ID")
      ? ""
      : " (no Message-ID yet: send.sh adds one, so the logged sha will differ; --dry-run first)";
    return {
      rcpts: recipientList([["To", addrs(all("To"))], ["Cc", addrs(all("Cc"))], ["Bcc", addrs(all("Bcc"))]]),
      subject: cap(all("Subject") || "(none)", 80),
      sha: sha + note,
    };
  } catch {
    return null;
  }
}

function sendReason(args, cwd) {
  const eml = args.find((a) => !a.startsWith("-"));
  const s = emlSummary(eml, cwd);
  const head = "smtp-egress: send a REAL email?";
  const tail = "egress-check runs after approval, inside send.sh, and a refusal aborts the send. Approve?";
  if (!s) return `${head} Recipients: unread, Subject: unread, sha256: unread (${cap(eml || "no .eml argument", 80)}). ${tail}`;
  return `${head} ${s.rcpts}. Subject: ${s.subject}. sha256: ${s.sha}. ${tail}`;
}

// ── Rule 2 reasons ─────────────────────────────────────────────────────────────────
const BYPASS =
  "— it skips egress-check, so the sender's own IP may reach the Received: headers. Use the plugin's scripts/send.sh, which runs egress-check first. Allow anyway?";

// Shell flags: returns { cmd } for -c strings, { script, args } for a script, or {} for stdin.
function shellArgs(rest) {
  let c = false, n = false;
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (w === "--") { i++; return pick(i); }
    if (/^[-+][oO]$/.test(w) || w === "--rcfile" || w === "--init-file") { i++; continue; }
    if (/^--/.test(w)) continue;
    if (/^[-+][A-Za-z]+$/.test(w)) { if (w[0] === "-" && w.includes("c")) c = true; if (w[0] === "-" && w.includes("n")) n = true; continue; }
    return pick(i);
  }
  return c ? { cmd: "" } : {};
  function pick(i) {
    if (i >= rest.length) return c ? { cmd: "" } : {};
    return c ? { cmd: rest[i] } : { script: rest[i], args: rest.slice(i + 1), noexec: n };
  }
}

// Analyse one simple command's words. Returns a reason or null.
function analyse(words, ctx, depth) {
  if (depth > MAX_DEPTH) throw new Unsure("depth");
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(words[i]) || KEYWORDS.has(words[i]))) i++;
  if (i >= words.length) return null;
  const w0 = words[i];
  const word = base(w0);
  const rest = words.slice(i + 1);

  if (PLUGIN_SCRIPT.test(word)) return pluginRule(w0, rest, ctx);
  // An unexpanded command word ($X, $(…)) cannot be resolved: unsure.
  if (w0.includes("$")) return DANGER.test(ctx.raw) ? "smtp-egress: cannot resolve a variable command word in a call that names a mail tool — " + BYPASS : null;

  if (WRAP[word]) {
    const spec = WRAP[word];
    let j = 0, pos = spec.pos || 0;
    while (j < rest.length) {
      const a = rest[j];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a) && (word === "env" || word === "sudo")) { j++; continue; }
      if (a === "--") { j++; break; }
      if (spec.v.has(a)) { j += 2; continue; }
      if (a.startsWith("-") && a.length > 1) {
        // env -S / --split-string runs its argument as a command line.
        if (word === "env" && (a === "-S" || a === "--split-string")) return check(rest[j + 1] || "", ctx, depth + 1);
        if (word === "env" && a.startsWith("--split-string=")) return check(a.slice(15), ctx, depth + 1);
        j++; continue;
      }
      if (pos > 0) { pos--; j++; continue; }
      break;
    }
    return analyse(rest.slice(j), ctx, depth + 1);
  }
  if (word === "command") {
    let j = 0;
    while (j < rest.length && rest[j].startsWith("-")) {
      if (/^-[a-zA-Z]*[vV]/.test(rest[j])) return null; // command -v / -V: a lookup, runs nothing
      j++;
    }
    return analyse(rest.slice(j), ctx, depth + 1);
  }
  if (word === "eval") return check(rest.join(" "), ctx, depth + 1);
  if (word === "nix") {
    const k = rest.findIndex((a) => a === "-c" || a === "--command");
    return k === -1 ? null : analyse(rest.slice(k + 1), ctx, depth + 1);
  }
  if (word === "find") {
    for (let k = 0; k < rest.length; k++) {
      if (/^-(exec|execdir|ok|okdir)$/.test(rest[k])) {
        let e = k + 1;
        while (e < rest.length && rest[e] !== ";" && rest[e] !== "+") e++;
        const r = analyse(rest.slice(k + 1, e), ctx, depth + 1);
        if (r) return r;
        k = e;
      }
    }
    return null;
  }
  if (word === "source" || word === ".") {
    const p = rest[0] || "";
    return PLUGIN_SCRIPT.test(base(p)) ? pluginRule(p, rest.slice(1), ctx) : null;
  }
  if (SHELL.test(word)) {
    const sa = shellArgs(rest);
    if ("cmd" in sa) return check(sa.cmd || "", ctx, depth + 1);
    if (sa.script !== undefined) {
      if (sa.noexec) return null; // sh -n only parses the script; it never runs it
      if (PLUGIN_SCRIPT.test(base(sa.script))) return pluginRule(sa.script, sa.args, ctx);
      if (sa.script.includes("$") && DANGER.test(ctx.raw)) return "smtp-egress: a shell runs a script named by a variable in a call that names a mail tool — " + BYPASS;
      return null;
    }
    ctx.stdinShell = true; // reads commands from stdin: decided after the whole call
    return null;
  }
  const args = stripRedirects(rest);
  if (word === "msmtp") {
    if (args.some((a) => a === "--version" || a === "--serverinfo" || a === "-S" || a === "--help" || a === "-h")) return null;
    return `smtp-egress: msmtp run directly ${BYPASS}`;
  }
  if (word === "sendmail" || word === "swaks") return `smtp-egress: ${word} ${BYPASS}`;
  if (word === "mail" || word === "mailx" || word === "mutt" || word === "neomutt") {
    const VAL = new Set(["-s", "-a", "-r", "-S", "-q", "-u", "-A", "-F", "-e", "-H", "-i"]);
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a === "-c" || a === "-b") return `smtp-egress: ${word} with a recipient ${BYPASS}`;
      if (a === "-f") return null; // reads a mailbox
      if (VAL.has(a)) { k++; continue; }
      if (a.startsWith("-")) continue;
      return `smtp-egress: ${word} with a recipient ${BYPASS}`;
    }
    return null;
  }
  if (word === "curl" && args.some((a) => /^(--url=)?smtps?:\/\//i.test(a))) return `smtp-egress: curl to an smtp(s):// URL ${BYPASS}`;
  if (word === "openssl" && args.includes("s_client") && args.some((a) => SMTP_PORT_IN.test(a) || SMTP_PORT_WORD.test(a))) {
    return `smtp-egress: openssl s_client to an SMTP port ${BYPASS}`;
  }
  if (/^(nc|ncat|netcat|socat|telnet)$/.test(word) && args.some((a) => SMTP_PORT_WORD.test(a) || SMTP_PORT_IN.test(a))) {
    return `smtp-egress: ${word} to an SMTP port ${BYPASS}`;
  }
  if (/^python(3(\.\d+)?)?$/.test(word)) {
    const ci = args.indexOf("-c");
    const code = [ci !== -1 ? args[ci + 1] || "" : "", ...ctx.heredocs].join("\n");
    if (/\bsmtplib\b/.test(code) && /\bSMTP(_SSL)?\s*\(/.test(code)) return `smtp-egress: python smtplib ${BYPASS}`;
  }
  return null;
}

// Returns a reason string for the first command in `cmd` that should ask, or null.
function check(cmd, ctx, depth = 0) {
  if (depth > MAX_DEPTH) throw new Unsure("depth");
  const all = commands(cmd);
  const sub = { cwd: ctx.cwd, raw: ctx.raw, stdinShell: false, heredocs: [] };
  for (const c of all) {
    sub.heredocs = c.heredocs;
    const r = analyse(c.words, sub, depth + 1);
    if (r) return r;
  }
  if (sub.stdinShell) {
    // A shell reading stdin (`cat <<EOF | bash`, `echo … | sh`): scan every heredoc in
    // the call, and if the call names a mail tool at all, ask — we cannot see the pipe.
    for (const h of all.flatMap((c) => c.heredocs)) {
      const hr = check(h, ctx, depth + 1);
      if (hr) return hr;
    }
    if (DANGER.test(cmd)) return "smtp-egress: a shell reads commands from a pipe that names a mail tool — " + BYPASS;
  }
  return null;
}

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
  if (ev.tool_name === "Bash") {
    const input = ev.tool_input || {};
    rawCmd = String(input.command || "");
    const ctx = { cwd: typeof ev.cwd === "string" ? ev.cwd : "", raw: rawCmd };
    const reason = check(rawCmd, ctx);
    if (reason) ask(reason);
  }
  process.exit(0);
} catch {
  // Unsure: overflow or a parse failure. Ask if the text names a mail tool; else fail open.
  if (rawCmd !== null && DANGER.test(rawCmd)) {
    ask("smtp-egress: this command could not be parsed with confidence and names a mail tool or send script — check it is not an unapproved send. Allow?");
  }
  process.exit(0);
}
