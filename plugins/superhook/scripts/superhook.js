#!/usr/bin/env node
// @ts-check
/**
 * superhook.js — supervising dispatcher for command-type hooks.
 *
 * The harness DOES emit a native `hook_execution_complete` OTel event carrying
 * hook_name / num_blocking / num_non_blocking_error (an earlier version of this
 * header claimed no such event exists — corrected 2026-09-06). What it does not
 * offer is INTERVENTION: nothing can downgrade one hook's verdict. So
 * observing is possible from outside, but overriding still requires BEING the
 * hook the harness invokes. The plugin's hooks/hooks.json calls this wrapper
 * instead of the inner hook directly:
 *
 *     node superhook.js <EventName> -- <inner command ...>
 *
 * Several arguments after `--` are run as an argv (no shell, so a path with a
 * space survives); a single argument is run as a shell string.
 *
 * The wrapper forwards the event payload (stdin) to the inner command, captures
 * its stdout / stderr / exit code, and then emits the FINAL decision. Its job:
 *
 *   1. Crash safety  — if the inner hook throws / exits with anything but 0 or 2
 *      / times out, never let it wedge the session. The wrapper emits NO
 *      decision, only a systemMessage, so the call goes through the normal
 *      permission flow ("staying silent doesn't approve it" —
 *      https://code.claude.com/docs/en/hooks#exit-code-output). It used to emit
 *      `decision: "approve"`, which on PreToolUse maps to `allow` and SKIPS the
 *      permission prompt (same page, PreToolUse decision control).
 *   2. Blocks pass through — a JSON block (`decision: "block"` or
 *      `permissionDecision: "deny"`) and an exit-2 block (stderr = reason, the
 *      documented convention) both reach the harness unchanged.
 *   3. Loop breaker, STOP ONLY — if the SAME block reason fires LOOP_LIMIT times
 *      in a row on Stop / SubagentStop, let the agent stop, loudly. A Stop block
 *      can trap an agent; a PreToolUse deny cannot (Claude just runs something
 *      else), so a repeated PreToolUse deny is only LOGGED as `loop-detected` and
 *      is never downgraded — downgrading it turned the third retry of a
 *      hard-blocked command into an allow. Upstream now ships its own Stop cap
 *      (8 consecutive continuations, CLAUDE_CODE_STOP_HOOK_BLOCK_CAP —
 *      https://code.claude.com/docs/en/hooks#stop-input); this one is lower and
 *      logged, which is why it stays.
 *   4. Log + recommend — every invocation is appended to superhook.log as a
 *      JSON line. The wrapper NEVER edits hook files itself.
 *
 * superhook-digest.js deliberately reads THIS log, not the native
 * hook_execution_complete counters: this wrapper exits 0 on a crash and on a
 * loop-break, so from the harness's side those incidents are indistinguishable
 * from a clean run (measured: PreToolUse:Bash reported 15,102 records at
 * num_blocking 0, num_non_blocking_error 0).
 *
 * Scope note: a `type: "prompt"` hook is evaluated by the model, not spawned —
 * it never routes through this wrapper and can never be overridden here.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Types only — erased at run time, so the script still needs nothing but `node`. They come
// from Anthropic's own SDK (CI installs it as a dev dependency and runs tsc over this file).
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SyncHookJSONOutput} SyncHookJSONOutput */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').PreToolUseHookSpecificOutput} PreToolUseHookSpecificOutput */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').HookEvent} HookEvent */
/** What the wrapper hands back to the harness. "No decision" is empty stdout + exit 0.
 * @typedef {{ stdout: string, stderr: string, code: number }} Result */

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const hooksDir = path.join(projectDir, ".claude", "hooks");
const logFile = path.join(hooksDir, "superhook.log");
const stateFile = path.join(hooksDir, ".superhook-state.json");

const LOOP_LIMIT = 3; // identical consecutive blocks before the loop breaker fires.

// Events whose block the harness acts on (exit-2 table,
// https://code.claude.com/docs/en/hooks#exit-code-2-behavior-per-event).
// StopFailure was listed here once; it fires on an API error and cannot block.
const DECISION_EVENTS = new Set(["Stop", "SubagentStop", "PreToolUse"]);
// Events where a repeated block can trap the agent, so the breaker may release it.
const LOOP_BREAK_EVENTS = new Set(["Stop", "SubagentStop"]);

// Inner budgets sit BELOW hooks/hooks.json's `timeout` (Stop 630 s, PreToolUse
// 20 s): a harness timeout discards the output and writes no log line, so the
// wrapper must give up first to record the incident. The Stop gate runs
// `nix flake check`, often well over a minute cold.
/** @type {Partial<Record<HookEvent, number>>} */
const INNER_TIMEOUT_MS = { Stop: 600_000, SubagentStop: 600_000 };
const DEFAULT_INNER_TIMEOUT_MS = 15_000;

// ---- helpers ----------------------------------------------------------------
const now = () => new Date().toISOString();

// Size-based rotation. Without it this file grows without bound inside the
// repo: measured at 1,074,908 bytes with no rotation.
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_BACKUPS = 3;
const rotateIfNeeded = () => {
  try {
    if (fs.statSync(logFile).size < LOG_MAX_BYTES) return;
  } catch {
    return; // no log yet — nothing to rotate
  }
  try {
    try {
      fs.rmSync(`${logFile}.${LOG_BACKUPS}`, { force: true });
    } catch {
      /* nothing to drop */
    }
    for (let i = LOG_BACKUPS - 1; i >= 1; i -= 1) {
      try {
        fs.renameSync(`${logFile}.${i}`, `${logFile}.${i + 1}`);
      } catch {
        /* that backup does not exist yet */
      }
    }
    fs.renameSync(logFile, `${logFile}.1`);
  } catch {
    /* rotation must never throw */
  }
};

const hash = (/** @type {unknown} */ s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 12);

/**
 * @param {string} event  the harness event name (argv[2]); not validated, hence string
 * @param {string[]} innerArgv
 * @param {string} stdin  the event payload, forwarded verbatim
 * @returns {Result}
 */
function main(event, innerArgv, stdin) {
  const isDecision = DECISION_EVENTS.has(event);
  const log = (/** @type {Record<string, unknown>} */ entry) => {
    try {
      rotateIfNeeded();
      fs.appendFileSync(logFile, JSON.stringify({ ts: now(), event, ...entry }) + "\n");
    } catch {
      /* logging must never throw */
    }
  };
  const readState = () => {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      return s && typeof s === "object" ? s : {};
    } catch {
      return {};
    }
  };
  const writeState = (/** @type {Record<string, unknown>} */ s) => {
    try {
      fs.writeFileSync(stateFile, JSON.stringify(s));
    } catch {
      /* best effort */
    }
  };
  // A result is { stdout, stderr, code }. "No decision" is empty stdout + exit 0.
  /** @returns {Result} */
  const notice = (/** @type {string} */ systemMessage) => {
    /** @type {SyncHookJSONOutput} */
    const json = { systemMessage };
    return { stdout: isDecision ? JSON.stringify(json) : "", stderr: "", code: 0 };
  };

  // Nothing to run: no-op pass so a mis-wired entry can't wedge us.
  if (innerArgv.length === 0) {
    log({ action: "noop", note: "no inner command after --" });
    return { stdout: "", stderr: "", code: 0 };
  }

  // ---- run the inner hook ---------------------------------------------------
  /** @type {import('node:child_process').SpawnSyncOptionsWithStringEncoding} */
  const opts = {
    cwd: projectDir,
    input: stdin,
    encoding: "utf8",
    timeout: INNER_TIMEOUT_MS[/** @type {HookEvent} */ (event)] || DEFAULT_INNER_TIMEOUT_MS,
    maxBuffer: 20 * 1024 * 1024,
  };
  /** @type {{ status: number | null, stdout?: string, stderr?: string, error?: Error }} */
  let res;
  try {
    res =
      innerArgv.length === 1
        ? spawnSync(innerArgv[0], { ...opts, shell: true })
        : spawnSync(innerArgv[0], innerArgv.slice(1), opts);
  } catch (e) {
    res = { status: -1, stdout: "", stderr: String(e && /** @type {Error} */ (e).message) };
  }
  const status = res.status;
  const out = (res.stdout || "").trim();
  const err = (res.stderr || "").trim();

  // ---- 1. crash safety: anything but exit 0 / exit 2 -------------------------
  if (res.error || (status !== 0 && status !== 2)) {
    const detail = (err || (res.error && res.error.message) || `exit ${status}`).slice(-1000);
    log({
      action: "crash-safe",
      status,
      stderr: detail,
      recommendation:
        `Inner ${event} hook failed (exit ${status}). superhook emitted no decision so the ` +
        `session is not wedged. Fix the script; reproduce by running it with the logged payload.`,
    });
    return notice(
      `superhook: inner ${event} hook crashed (exit ${status}) — the gate did NOT run, and no ` +
        `decision was emitted (normal permission flow applies). Logged to .claude/hooks/superhook.log.`,
    );
  }

  // ---- classify the inner verdict -------------------------------------------
  // The INNER hook's stdout is the only hook JSON this wrapper reads; typing it as the SDK's
  // SyncHookJSONOutput checks `decision` / `permissionDecision` against the real enums.
  /** @type {SyncHookJSONOutput | undefined} */
  let parsed;
  if (out) {
    try {
      parsed = JSON.parse(out);
    } catch {
      /* plain text — passed through verbatim below */
    }
  }
  if (!parsed || typeof parsed !== "object") parsed = undefined;
  // Only PreToolUse's specific output carries a permission decision; any other event's
  // object simply lacks those keys, which reads the same as `{}`.
  const hso = /** @type {Partial<PreToolUseHookSpecificOutput>} */ ((parsed && parsed.hookSpecificOutput) || {});
  const blocked =
    status === 2 || (parsed && parsed.decision === "block") || hso.permissionDecision === "deny";
  const approved =
    !blocked && ((parsed && parsed.decision === "approve") || hso.permissionDecision === "allow");
  // String(): a non-string reason must not throw below and drop the block.
  const reason = String(
    status === 2 ? err : (parsed && parsed.reason) || hso.permissionDecisionReason || "",
  );
  const passThrough = { stdout: out, stderr: status === 2 ? err : "", code: status === 2 ? 2 : 0 };

  // ---- 2./3. blocks: pass through; loop-break on Stop only ------------------
  if (isDecision && blocked) {
    const reasonHash = hash(reason);
    const state = readState();
    const prev = state[event] || { hash: null, count: 0 };
    const count = prev.hash === reasonHash ? prev.count + 1 : 1;
    state[event] = { hash: reasonHash, count: count >= LOOP_LIMIT ? 0 : count };
    writeState(state);

    if (count >= LOOP_LIMIT && LOOP_BREAK_EVENTS.has(event)) {
      log({
        action: "loop-break",
        occurrences: count,
        blockedReason: reason.slice(0, 500),
        recommendation:
          `The ${event} hook blocked with the SAME reason ${count}x in a row — likely a ` +
          `mis-firing gate trapping the agent. superhook let it stop. Investigate why the ` +
          `condition never clears and fix the inner hook's logic or the underlying state.`,
      });
      // No `decision` field: on Stop that is how "allow it to stop" is spelled
      // (https://code.claude.com/docs/en/hooks#stop-decision-control).
      return notice(
        `superhook: ${event} hook blocked ${count}x with an identical reason and was ` +
          `overridden to prevent a wedge. Original reason: ${reason.slice(0, 300)} ` +
          `— see .claude/hooks/superhook.log and fix the gate.`,
      );
    }
    if (count >= LOOP_LIMIT) {
      // PreToolUse: the deny STANDS. Surface the pattern for review only.
      log({
        action: "loop-detected",
        occurrences: count,
        blockedReason: reason.slice(0, 500),
        recommendation:
          `The ${event} hook denied the SAME reason ${count}x in a row. The deny was kept ` +
          `(a tool deny cannot wedge a session). Check whether the agent is retrying a ` +
          `blocked command or the rule is misfiring.`,
      });
    } else {
      log({ action: "pass-block", occurrences: count });
    }
    return passThrough;
  }

  if (isDecision && approved) {
    const state = readState();
    if (state[event]) {
      delete state[event];
      writeState(state);
    }
    log({ action: "pass-approve" });
  } else {
    log({ action: "pass-through", status, hadOutput: Boolean(out) });
  }
  // Empty output stays empty: no synthesized approve (see header, item 1).
  return passThrough;
}

// ---- entry ----------------------------------------------------------------
/** @type {Result} */
let result;
try {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf("--");
  const event = argv[0] || "Unknown";
  const innerArgv = sep >= 0 ? argv.slice(sep + 1) : [];
  let stdin = "";
  try {
    stdin = fs.readFileSync(0, "utf8");
  } catch {
    /* no stdin — fine */
  }
  result = main(event, innerArgv, stdin);
} catch (e) {
  // The wrapper itself must not throw: fail to "no decision", never to allow —
  // and leave a crash-safe line so the digest still sees it.
  const msg = `superhook internal error: ${String(e && /** @type {Error} */ (e).message)}`;
  try {
    fs.appendFileSync(logFile, JSON.stringify({ ts: now(), event: process.argv[2] || "Unknown", action: "crash-safe", status: "internal", stderr: msg }) + "\n");
  } catch {
    /* logging must never throw */
  }
  result = { stdout: "", stderr: msg, code: 0 };
}
// exitCode + natural exit, not process.exit(): stdout to a pipe is async on
// POSIX, and process.exit() right after write() can truncate a large payload
// (https://nodejs.org/api/process.html#a-note-on-process-io).
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.code;
