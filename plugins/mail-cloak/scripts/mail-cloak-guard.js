#!/usr/bin/env node
/**
 * PreToolUse guard for mail-cloak: a human approves every email before it leaves.
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
 * Rule 3 (1.1.0) — mailbox changes outside inbox.sh. inbox.sh list/search/read/folders
 *   is allowed (read-only, proxied). A direct `himalaya` is allowed only for its read-only
 *   subcommands (tree from himalaya 2.2.1 --help); anything that deletes, moves, copies,
 *   flags, appends, creates, expunges or SENDS (message send/compose/reply/forward, smtp)
 *   asks, as does `message read --seen` and any subcommand not known to be read-only.
 *   curl to imap(s)/pop3(s) with a mutating -X or an upload, and python imaplib calling
 *   store/expunge/delete/move/copy/append, ask too.
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
const DANGER = /\b(msmtp[\w-]*|sendmail|swaks|smtplib|imaplib|himalaya|send\.sh|header-check\.sh)\b|(smtps?|imaps?|pop3s?):\/\//i;

// ── Shell parser — copied from mac-app-send's mac-send-guard.js ─────────────────────
// Plugins install independently, so a shared module cannot be required across them.
// The places that differ from mac-app-send 1.1.4 are marked "FIX"; mac-app-send 1.1.5+
// carries the same fixes.
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
          val += "$()"; // the word now holds a substitution: the command word rule sees it
          j = k + 1;
        } else if (src[j] === "`") {
          const k = src.indexOf("`", j + 1);
          const end = k === -1 ? src.length : k;
          out.push(...commands(src.slice(j + 1, end), depth + 1));
          val += "$()";
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
      word = (word ?? "") + "$()";
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
      const rawDelim = src.slice(j, k);
      const delim = rawDelim.replace(/['"\\]/g, "");
      // FIX (1.1.0 review): remember whether the delimiter was quoted. An UNQUOTED body
      // still expands $( … ) and backticks when the shell reads it.
      if (delim) pendingHeredocs.push({ delim, owner: cur, quoted: /['"\\]/.test(rawDelim) });
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
        const body = lines.join("\n");
        h.owner.heredocs.push(body);
        if (!h.quoted) out.push(...substitutionsIn(body, depth));
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

// FIX (1.1.0 review): the $( … ) and `…` commands inside an unquoted heredoc body — the
// same expansion the double-quote branch already scans. A backslash escapes the next char.
function substitutionsIn(text, depth) {
  const found = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text.startsWith("$(", i)) {
      const k = matchParen(text, i + 1);
      found.push(...commands(text.slice(i + 2, k), depth + 1));
      i = k;
    } else if (text[i] === "`") {
      const k = text.indexOf("`", i + 1);
      const end = k === -1 ? text.length : k;
      found.push(...commands(text.slice(i + 1, end), depth + 1));
      i = end;
    }
  }
  return found;
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
// Every script the plugin ships. send/header-check/inbox have argument rules; the others
// only read or write local files, and ask only under a MAIL_CLOAK_* override.
const PLUGIN_SCRIPT = /^(send|header-check|inbox|doctor|egress-check|new-eml)\.sh$/;
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
  arch: { v: ["-arch", "-e", "-d"] }, // -arm64 / -x86_64 are plain flags
  script: { v: ["-t", "-T", "-B", "-I", "-O", "--log-io", "--log-out", "--log-in", "--log-timing", "-E", "--echo"], pos: 1 }, // the typescript file
  flock: { v: ["-w", "--wait", "--timeout", "-E", "--conflict-exit-code"], pos: 1 }, // the lock file
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
  // An MAIL_CLOAK_* assignment anywhere in the call (prefix, env, export) can swap the
  // config, the state dir or a test-only switch under the script: never sanctioned.
  if (ENV_OVERRIDE.test(ctx.raw)) return ENV_REASON;
  if (/^(doctor|egress-check|new-eml)\.sh$/.test(base(script))) return null;
  if (base(script) === "inbox.sh") {
    // Read-only by construction; anything else is not a known inbox.sh call: unsure.
    return INBOX_OK.has(args[0]) ? null : INBOX_REASON;
  }
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
const ENV_OVERRIDE = /\b(MAIL_CLOAK|SMTP_EGRESS)_[A-Za-z0-9_]*=/; // SMTP_EGRESS_*: the pre-rename prefix
const ENV_REASON =
  "mail-cloak: a plugin script runs with a MAIL_CLOAK_* override in the same call, which can swap its config or switch off a safety check. Allow anyway?";
const INBOX_OK = new Set(["list", "search", "read", "folders", "-h", "--help"]);
const INBOX_REASON =
  "mail-cloak: inbox.sh takes list, search, read or folders; this call is none of them. Allow anyway?";
const HC_REASON =
  "mail-cloak: header-check sends a REAL probe email to PROBE_RECIPIENT through send.sh (egress-check runs inside it, after approval). Approve this send?";

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
  const head = "mail-cloak: send a REAL email?";
  const tail = "egress-check runs after approval, inside send.sh, and a refusal aborts the send. Approve?";
  if (!s) return `${head} Recipients: unread, Subject: unread, sha256: unread (${cap(eml || "no .eml argument", 80)}). ${tail}`;
  return `${head} ${s.rcpts}. Subject: ${s.subject}. sha256: ${s.sha}. ${tail}`;
}

// ── Rule 2 reasons ─────────────────────────────────────────────────────────────────
const BYPASS =
  "— it skips egress-check, so the sender's own IP may reach the Received: headers. Use the plugin's scripts/send.sh, which runs egress-check first. Allow anyway?";

// ── Rule 3: mailbox changes ─────────────────────────────────────────────────────────
const MAILBOX =
  "— it changes the mailbox outside the plugin. The plugin reads mail only through inbox.sh (read-only, proxied, never marks \\Seen). Allow anyway?";
const READ_ROUTE =
  "— read through the plugin's inbox.sh instead, which always uses the SOCKS proxy and never marks \\Seen. Allow anyway?";
const MAIL_MUTATION = /\b(STORE|EXPUNGE|DELETE|DELE|MOVE|COPY|APPEND|CREATE|RENAME)\b/i;
// himalaya 2.2.1: global options that take a value, the subcommand aliases from its
// --help, and the (command, subcommand) pairs that only read.
const HIM_VAL = new Set(["-c", "--config", "-a", "--account", "-b", "--backend", "--log-level", "--log", "--log-file"]);
const HIM_ALIAS = { msg: "message", ls: "list", sr: "search", rm: "delete", mv: "move", cp: "copy", save: "add", write: "compose", fwd: "forward", dl: "download", wizard: "configure" };
const HIM_READ = new Set([
  "mailbox list", "envelope list", "envelope search", "message read", "attachment list",
  "account list", "account check",
  "imap id", "imap list", "imap status", "imap search", "imap sort", "imap thread", "imap flag",
]);
const HIM_ANY = new Set(["help", "completion", "manual", "json-schema"]);
const HIM_SEND = new Set(["message send", "message compose", "message reply", "message forward"]);
function himalayaRule(args, ctx) {
  const pos = [];
  let seen = false, info = false, dd = false, config = /\bHIMALAYA_CONFIG=/.test(ctx.raw);
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (dd) { pos.push(a); continue; } // after `--` every word is positional, not a flag
    if (a === "--") { dd = true; continue; }
    if (a === "-c" || a === "--config" || a.startsWith("--config=") || /^-c./.test(a)) config = true;
    if (HIM_VAL.has(a)) { k++; continue; }
    if (a === "--seen") seen = true;
    if (a === "-h" || a === "--help" || a === "-V" || a === "--version") info = true;
    if (a.startsWith("-")) continue;
    pos.push(HIM_ALIAS[a] || a);
  }
  // An explicit config may have no proxy (or a different one): inbox.sh, which generates
  // a proxied config per run, is the sanctioned way to read.
  if (config) return `mail-cloak: himalaya with an explicit config (-c / --config / HIMALAYA_CONFIG) may connect without this plugin's proxy ${READ_ROUTE}`;
  if (!pos.length) return info ? null : `mail-cloak: bare himalaya runs its interactive account setup, which connects without this plugin's proxy ${MAILBOX}`;
  if (HIM_ANY.has(pos[0])) return null;
  const pair = pos.slice(0, 2).map((p) => HIM_ALIAS[p] || p).join(" ");
  if (info && pos.length <= 2) return null; // `himalaya message delete --help` only prints help
  if (pair === "message read" && seen) return `mail-cloak: himalaya message read --seen marks the message \\Seen ${MAILBOX}`;
  if (HIM_READ.has(pair)) return null;
  if (HIM_SEND.has(pair) || pos[0] === "smtp") return `mail-cloak: himalaya ${pair} SENDS mail outside the msmtp gate ${BYPASS}`;
  return `mail-cloak: himalaya ${pair} is not a known read-only command ${MAILBOX}`;
}

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

// The code an interpreter runs from its arguments (python -c, perl/ruby -e, node -e/-p,
// osascript -e; short-flag clusters such as -Ic or -le count) plus any heredoc fed to it.
// null when `word` is not one of them.
function interpreterCode(word, args, heredocs) {
  let flag;
  if (/^python(\d(\.\d+)?)?$/.test(word)) flag = "c";
  else if (/^(perl|ruby|osascript)$/.test(word)) flag = "eE";
  else if (/^(node|nodejs|bun|deno)$/.test(word)) flag = "ep";
  else return null;
  const parts = [...heredocs];
  const re = new RegExp(`^-[A-Za-z]*?[${flag}](.*)$`);
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--eval" || a === "--print") { parts.push(args[k + 1] || ""); k++; continue; }
    if (a.startsWith("--eval=") || a.startsWith("--print=")) { parts.push(a.slice(a.indexOf("=") + 1)); continue; }
    if (a.startsWith("--")) continue;
    const m = a.match(re);
    if (m) { if (m[1]) parts.push(m[1]); else { parts.push(args[k + 1] || ""); k++; } }
  }
  return parts.join("\n");
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
  if (/[*?[]/.test(w0) || /^\$.*\\/.test(w0)) return "mail-cloak: the command word is a glob or an escaped $'…' string the guard cannot resolve — " + BYPASS;
  if (w0.includes("$")) return DANGER.test(ctx.raw) ? "mail-cloak: cannot resolve a variable command word in a call that names a mail tool — " + BYPASS : null;

  if (word === "su" || ((word === "script" || word === "flock") && rest.some((a) => a === "-c" || a === "--command"))) {
    // su/script/flock -c STRING run that string through a shell.
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k];
      if (a === "-c" || a === "--command") { const r = check(rest[k + 1] || "", ctx, depth + 1); if (r) return r; }
      else if (a.startsWith("--command=")) { const r = check(a.slice(10), ctx, depth + 1); if (r) return r; }
    }
    return null;
  }
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
  if (word === "alias") {
    // An alias whose value names a mail tool turns a later innocent-looking word into it.
    if (rest.some((a) => DANGER.test(a.slice(a.indexOf("=") + 1)))) return `mail-cloak: an alias that names a mail tool hides what a later command runs ${BYPASS}`;
    return null;
  }
  if (word === "shopt" && rest.includes("expand_aliases") && rest.some((a) => /^-[a-z]*s/.test(a))) {
    return "mail-cloak: shopt -s expand_aliases lets an alias hide what a later command runs, which this guard cannot follow. Allow anyway?";
  }
  if (word === "nix") {
    const r = rest.indexOf("run");
    if (r !== -1 && rest.slice(0, r).every((a) => a.startsWith("-"))) {
      // `nix run <installable> [-- args]` runs the installable's program with those args.
      const inst = rest.slice(r + 1).find((a) => !a.startsWith("-")) || "";
      const prog = inst.includes("#") ? inst.split("#").pop().split(".").pop() : base(inst);
      const dd = rest.indexOf("--");
      const r2 = analyse([prog, ...(dd === -1 ? [] : rest.slice(dd + 1))], ctx, depth + 1);
      if (r2) return r2;
    }
    const k = rest.findIndex((a) => a === "-c" || a === "--command");
    return k === -1 ? null : analyse(rest.slice(k + 1), ctx, depth + 1);
  }
  if (word === "nix-shell") {
    for (let k = 0; k < rest.length; k++) {
      if (rest[k] === "--run" || rest[k] === "--command") {
        const r = check(rest[k + 1] || "", ctx, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }
  if (word === "watch") {
    // watch runs its arguments through `sh -c`: check them as one command line.
    let j = 0;
    while (j < rest.length && rest[j].startsWith("-")) j += /^(-n|--interval|-q|--equexit)$/.test(rest[j]) ? 2 : 1;
    return check(rest.slice(j).join(" "), ctx, depth + 1);
  }
  if (word === "parallel") {
    return DANGER.test(rest.join(" ")) ? `mail-cloak: parallel runs a command line that names a mail tool ${BYPASS}` : null;
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
      if (sa.script.includes("$") && DANGER.test(ctx.raw)) return "mail-cloak: a shell runs a script named by a variable in a call that names a mail tool — " + BYPASS;
      return null;
    }
    ctx.stdinShell = true; // reads commands from stdin: decided after the whole call
    return null;
  }
  const args = stripRedirects(rest);
  if (/^msmtp(q|-queue)$/.test(word)) return `mail-cloak: ${word} queues and sends mail ${BYPASS}`;
  if (word === "git" && args.some((a) => a === "send-email" || a === "imap-send")) return `mail-cloak: git ${args.find((a) => a === "send-email" || a === "imap-send")} sends mail or writes a mailbox ${BYPASS}`;
  if (word === "msmtp") {
    if (args.some((a) => a === "--version" || a === "--serverinfo" || a === "-S" || a === "--help" || a === "-h")) return null;
    return `mail-cloak: msmtp run directly ${BYPASS}`;
  }
  if (word === "sendmail" || word === "swaks") return `mail-cloak: ${word} ${BYPASS}`;
  if (word === "mail" || word === "mailx" || word === "mutt" || word === "neomutt") {
    const VAL = new Set(["-s", "-a", "-r", "-S", "-q", "-u", "-A", "-F", "-e", "-H", "-i"]);
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a === "-c" || a === "-b") return `mail-cloak: ${word} with a recipient ${BYPASS}`;
      if (a === "-f") return null; // reads a mailbox
      if (VAL.has(a)) { k++; continue; }
      if (a.startsWith("-")) continue;
      return `mail-cloak: ${word} with a recipient ${BYPASS}`;
    }
    return null;
  }
  if (word === "curl") {
    if (args.some((a) => /^(--url=)?smtps?:\/\//i.test(a))) return `mail-cloak: curl to an smtp(s):// URL ${BYPASS}`;
    if (args.some((a) => /^--mail-(rcpt|from|auth)(=|$)/.test(a))) return `mail-cloak: curl with SMTP envelope flags sends mail ${BYPASS}`;
    const req = [];
    let upload = false, cfg = false;
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a.startsWith("--")) {
        if (a === "--request") req.push(args[k + 1] || "");
        else if (a.startsWith("--request=")) req.push(a.slice(10));
        else if (a === "--upload-file" || a.startsWith("--upload-file=")) upload = true;
        else if (a === "--config" || a.startsWith("--config=")) cfg = true;
        continue;
      }
      // Short-flag clusters: -sX VALUE, -XVALUE, -sT FILE, -sK FILE.
      const m = a.match(/^-([A-Za-z]*?)([XTK])(.*)$/);
      if (!m) continue;
      if (m[2] === "X") req.push(m[3] || args[k + 1] || "");
      else if (m[2] === "T") upload = true;
      else cfg = true;
    }
    if (cfg) return "mail-cloak: curl -K / --config reads its options and URLs from a file the guard cannot see. Allow anyway?";
    if (args.some((a) => /^(--url=)?(imaps?|pop3s?):\/\//i.test(a))) {
      if (upload || req.some((r) => MAIL_MUTATION.test(r))) return `mail-cloak: curl changes a mailbox over IMAP/POP3 ${MAILBOX}`;
      // curl's IMAP FETCH uses BODY[] (sets \Seen) and does not go through the plugin's proxy.
      return `mail-cloak: curl reads IMAP/POP3 directly, unproxied, and its FETCH marks mail \\Seen ${READ_ROUTE}`;
    }
  }
  if (word === "himalaya") {
    const r = himalayaRule(args, ctx);
    if (r) return r;
  }
  if (word === "openssl" && args.includes("s_client") && args.some((a) => SMTP_PORT_IN.test(a) || SMTP_PORT_WORD.test(a))) {
    return `mail-cloak: openssl s_client to an SMTP port ${BYPASS}`;
  }
  if (/^(nc|ncat|netcat|socat|telnet)$/.test(word) && args.some((a) => SMTP_PORT_WORD.test(a) || SMTP_PORT_IN.test(a))) {
    return `mail-cloak: ${word} to an SMTP port ${BYPASS}`;
  }
  const interp = interpreterCode(word, args, ctx.heredocs);
  if (interp !== null) {
    if (/^python/.test(word)) {
      if (/\bsmtplib\b/.test(interp) && /\bSMTP(_SSL)?\s*\(/.test(interp)) return `mail-cloak: python smtplib ${BYPASS}`;
      // Any IMAP use asks: FETCH RFC822/BODY[] sets \Seen, and getattr or
      // _simple_command defeat matching method names.
      if (/imap/i.test(interp)) return `mail-cloak: python uses IMAP directly (unproxied; a FETCH of BODY[] or RFC822 marks mail \\Seen) ${READ_ROUTE}`;
    }
    if (DANGER.test(interp)) return `mail-cloak: ${word} runs code that names a mail tool ${BYPASS}`;
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
    if (DANGER.test(cmd)) return "mail-cloak: a shell reads commands from a pipe that names a mail tool — " + BYPASS;
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
let raw = "";
try {
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    process.exit(0);
  }
  if (!raw.trim()) process.exit(0);

  const ev = JSON.parse(raw.replace(/^\uFEFF/, "")); // a BOM is not JSON
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
  // Malformed or truncated JSON leaves rawCmd unset, so test the raw stdin text too.
  if ((rawCmd !== null && DANGER.test(rawCmd)) || (rawCmd === null && DANGER.test(raw))) {
    ask("mail-cloak: this command could not be parsed with confidence and names a mail tool or send script — check it is not an unapproved send. Allow?");
  }
  process.exit(0);
}
