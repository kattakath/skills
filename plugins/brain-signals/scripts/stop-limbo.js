#!/usr/bin/env node
// @ts-check
/**
 * Stop hook: warn when a turn ends in LIMBO — the reader cannot tell whether Claude is
 * waiting on something or expecting an answer. Two shapes, both measured as the
 * complaint this exists for:
 *
 *   open-question  the reply's last paragraph is a prose question or offer ("want me
 *                  to…?", "let me know") and no AskUserQuestion call followed it, so the
 *                  decision has no click-to-select options
 *   silent-wait    background work is still in flight and the reply never says it is
 *                  waiting for it, so the session looks finished when it is paused
 *
 * WARN MODE ONLY. Output is `{"systemMessage": "…"}` — shown to the user, nothing more.
 * It deliberately carries no `decision` and no `hookSpecificOutput.additionalContext`:
 * on Stop BOTH of those continue the conversation (hooks reference, "Stop decision
 * control"), which would make an advisory into a gate. Whether to block is a later
 * decision, taken after the log below has counted the false positives.
 *
 * SOURCES, in order of trust (hooks reference, "Stop input"):
 *   - `last_assistant_message` is the final text. The reference warns the transcript
 *     "isn't guaranteed to include the final message at Stop time", so the transcript
 *     is only a fallback for it.
 *   - `background_tasks` is the native in-flight list. It is "present when the task
 *     registry is reachable", so ABSENT does not mean idle: then, and only then, the
 *     transcript tail is replayed for launches without a terminal task-notification.
 *   - the transcript tail is also the only place an AskUserQuestion call is visible.
 *
 * FAIL OPEN. Any error — unparseable stdin, a missing or malformed transcript — exits 0
 * with no output. An advisory must never wedge a turn, and a guess is worse than silence.
 *
 * The log (one JSON line per warning: ts, case, session_id — never any reply text) is
 * there so the false-positive rate can be counted before block mode is considered.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Types only — erased at run time, so the hook still needs nothing but `node`. They come
// from Anthropic's own SDK (CI installs it as a dev dependency and runs tsc over this file).
/** @typedef {import('@anthropic-ai/claude-agent-sdk').StopHookInput} StopHookInput */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').BackgroundTaskSummary} BackgroundTaskSummary */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SyncHookJSONOutput} SyncHookJSONOutput */
// The transcript JSONL has no published type; only the fields read here are named.
/** @typedef {{ type?: string, text?: unknown, name?: string, id?: string, tool_use_id?: string, input?: { task_id?: unknown } }} Block */
/** @typedef {{ type?: string, isMeta?: boolean, isSidechain?: boolean, toolUseResult?: any, message?: { content?: unknown } }} Entry */
/** @typedef {"open-question" | "silent-wait"} Case */

const TAIL_BYTES = 1024 * 1024; // transcripts reach 80+ MB; the current turn is at the end
const TERMINAL = /^(?:completed|failed|killed|stopped|cancell?ed|error)$/i;

// A reply that says it is waiting. Checked against the whole reply.
const WAIT =
  /\b(?:wait(?:ing)?|watch(?:ing|er)?|background|I'll report|I will report|resume|notif(?:y|ied|ications?)|still running|in flight|when it (?:finishes|lands|completes))\b|⏳/i;

// Prose offers that hand a decision back as free text. Checked on the last paragraph.
const OFFER =
  /\b(?:let me know|want me to|should I|shall I|say the word|tell me if|would you like|do you want)\b/i;

/** @param {string} s @returns {any} */
function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// Typographic apostrophes and quotes folded to ASCII, so `I’ll report` matches the same
// regex as `I'll report` — models emit both.
/** @param {unknown} text */
function normalize(text) {
  return String(text || "").replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
}

// A markdown thematic break (`---`, `***`, `___`): layout, not a paragraph of prose.
const RULE = /^(?:[-*_][ \t]*){3,}$/;

// The last paragraph of prose. Code is removed — fenced blocks AND inline spans, because
// a regex or a shell glob ending in `?` is not a question — and a trailing thematic break
// is skipped, so `Want me to?` followed by `---` is still the paragraph that is read.
// Trailing emphasis/brackets/quotes are stripped later so `**Proceed?**` still reads.
/** @param {string | undefined} text */
function lastParagraph(text) {
  const prose = normalize(text)
    .replace(/```[\s\S]*?(?:```|$)/g, "")
    .replace(/`[^`\n]*`/g, "CODE");
  const paras = prose
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !RULE.test(p));
  return paras.length ? paras[paras.length - 1] : "";
}

/** @param {string | undefined} text */
function isOpenQuestion(text) {
  const p = lastParagraph(text);
  if (!p) return false;
  const end = p.replace(/[\s*_)\]"'`’”]+$/u, "");
  return end.endsWith("?") || OFFER.test(p);
}

// ── transcript tail ──────────────────────────────────────────────────────────────

// Parsed entries from the last TAIL_BYTES. Throws on a missing file; returns [] when
// nothing parses, which the caller treats as "malformed" and goes silent.
/** @param {string} file @returns {Entry[]} */
function readTail(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let lines = buf.toString("utf8").split("\n");
    if (size > len) lines = lines.slice(1); // first line is cut mid-record
    const out = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      const o = safeParse(l);
      if (o && typeof o === "object") out.push(o);
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** @param {Entry | undefined} entry @returns {Block[]} */
function blocks(entry) {
  const c = entry && entry.message && entry.message.content;
  if (Array.isArray(c)) return c;
  if (typeof c === "string") return [{ type: "text", text: c }];
  return [];
}

/** @param {Entry} entry */
function userText(entry) {
  return blocks(entry)
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

// A user entry that STARTS a turn: a prompt, a task-notification or a peer message —
// anything but a tool result or a meta/system injection.
/** @param {Entry | undefined} entry */
function startsTurn(entry) {
  if (!entry || entry.type !== "user" || entry.isMeta === true) return false;
  return !blocks(entry).some((b) => b && b.type === "tool_result");
}

// Assistant content blocks of the current (last) turn, in order.
/** @param {Entry[]} entries @returns {Block[]} */
function currentTurnBlocks(entries) {
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (startsTurn(entries[i])) {
      start = i + 1;
      break;
    }
  }
  const out = [];
  for (const e of entries.slice(start)) {
    if (e.type === "assistant" && e.isSidechain !== true) out.push(...blocks(e));
  }
  return out;
}

/** @param {Block[]} turn @returns {string} */
function finalTextFrom(turn) {
  for (let i = turn.length - 1; i >= 0; i--) {
    const b = turn[i];
    if (b && b.type === "text" && typeof b.text === "string" && b.text.trim()) return b.text;
  }
  return "";
}

// True when an AskUserQuestion call came after the turn's last text block (or the
// turn has no text at all and asked one).
/** @param {Block[]} turn */
function askedAfterText(turn) {
  let lastText = -1;
  for (let i = 0; i < turn.length; i++) {
    const b = turn[i];
    if (b && b.type === "text" && typeof b.text === "string" && b.text.trim()) lastText = i;
  }
  for (let i = lastText + 1; i < turn.length; i++) {
    const b = turn[i];
    if (b && b.type === "tool_use" && b.name === "AskUserQuestion") return true;
  }
  return false;
}

/** @param {string} s @param {string} name */
function tag(s, name) {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(s);
  return m ? m[1].trim() : null;
}

// Fallback when `background_tasks` is absent: launches confirmed by their tool result
// (Bash `backgroundTaskId`; Agent `isAsync` / `async_launched`), minus any that a
// task-notification reported terminal or TaskStop stopped. Teammates are long-lived by
// design and are not counted.
/** @param {Entry[]} entries */
function pendingFromTranscript(entries) {
  const pending = new Map(); // tool_use id -> task id
  const done = new Set(); // tool_use ids and task ids reported terminal
  for (const e of entries) {
    if (e.type === "assistant") {
      for (const b of blocks(e)) {
        if (b && b.type === "tool_use" && b.name === "TaskStop" && b.input && b.input.task_id) {
          done.add(String(b.input.task_id));
        }
      }
      continue;
    }
    if (e.type !== "user") continue;
    const r = e.toolUseResult;
    for (const b of blocks(e)) {
      if (!b || b.type !== "tool_result" || !b.tool_use_id || !r || typeof r !== "object") continue;
      const taskId = r.backgroundTaskId || ((r.isAsync === true || r.status === "async_launched") && r.agentId);
      if (taskId) pending.set(String(b.tool_use_id), String(taskId));
    }
    const text = userText(e);
    if (text.includes("<task-notification>")) {
      const status = tag(text, "status");
      if (status && TERMINAL.test(status)) {
        const tu = tag(text, "tool-use-id");
        const ti = tag(text, "task-id");
        if (tu) done.add(tu);
        if (ti) done.add(ti);
      }
    }
  }
  let n = 0;
  for (const [tu, ti] of pending) if (!done.has(tu) && !done.has(ti)) n++;
  return n;
}

// ── output ───────────────────────────────────────────────────────────────────────

function logDir() {
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(state, "brain-signals");
}

/** @param {Case[]} cases @param {unknown} sessionId */
function logCases(cases, sessionId) {
  try {
    const dir = logDir();
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    const sid = typeof sessionId === "string" ? sessionId : null;
    const lines = cases.map((c) => JSON.stringify({ ts, case: c, session_id: sid })).join("\n");
    fs.appendFileSync(path.join(dir, "stop-limbo.jsonl"), lines + "\n");
  } catch {
    // a log that cannot be written must not suppress the warning
  }
}

/** @type {Record<Case, string>} */
const MESSAGES = {
  "open-question":
    "[open-question] the reply ends on a prose question or offer, with no AskUserQuestion options after it",
  "silent-wait":
    "[silent-wait] background work is still running and the reply does not say it is waiting for it",
};

// A native `background_tasks` entry that means "paused, waiting". Teammates (Agent Teams)
// are long-lived by design, like the transcript fallback's `teammate_spawned`, so a lead
// session would otherwise warn on every reply while its team exists.
// Typed as the SDK's entry, but still guarded: the payload is untrusted JSON.
/** @param {BackgroundTaskSummary} t */
function inFlight(t) {
  return Boolean(t) && typeof t === "object" && t.type !== "teammate" && !TERMINAL.test(String(t.status || ""));
}

/** @param {string} p */
function expandHome(p) {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

function main() {
  /** @type {StopHookInput | undefined} */
  const input = safeParse(fs.readFileSync(0, "utf8"));
  if (!input || typeof input !== "object") return;
  if (input.stop_hook_active === true) return;

  /** @type {Entry[] | null} */
  let entries = null;
  const transcript = () => {
    if (entries === null) {
      if (typeof input.transcript_path !== "string") throw new Error("no transcript");
      entries = readTail(expandHome(input.transcript_path));
      if (!entries.length) throw new Error("malformed transcript");
    }
    return entries;
  };

  const native = typeof input.last_assistant_message === "string";
  const finalText = native ? input.last_assistant_message : finalTextFrom(currentTurnBlocks(transcript()));

  /** @type {Case[]} */
  const cases = [];

  const running = Array.isArray(input.background_tasks)
    ? input.background_tasks.filter(inFlight).length
    : pendingFromTranscript(transcript());
  if (running > 0 && !WAIT.test(normalize(finalText))) cases.push("silent-wait");

  // The AskUserQuestion exemption is only visible in the transcript. When it cannot be
  // read, this case cannot be decided, so it stays silent rather than guess.
  if (isOpenQuestion(finalText)) {
    let asked = true;
    try {
      asked = askedAfterText(currentTurnBlocks(transcript()));
    } catch {
      asked = true;
    }
    if (!asked) cases.push("open-question");
  }

  if (!cases.length) return;
  logCases(cases, input.session_id);
  const body = cases.map((c) => MESSAGES[c]).join("; ");
  /** @type {SyncHookJSONOutput} */
  const out = { systemMessage: `brain-signals stop-limbo (warn only): ${body}.` };
  process.stdout.write(JSON.stringify(out));
}

try {
  main();
} catch {
  // fail open: no output, exit 0
}
process.exitCode = 0;
