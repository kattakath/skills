#!/usr/bin/env node
/*
 * page-lab-gate — the deterministic wrapper around an unattended browser run
 * (docs/page-lab-vnext-design.md §7). Navigation goes through `nav` ONLY: it pops the next
 * queue item, navigates, runs every fixed detector (references/gate-detectors.json), and
 * either prints the page id or writes a page-lab/block@1 event and exits 10. The model never
 * calls navigate_page itself in unattended mode, so it cannot route around a detector.
 *
 *   page-lab-gate run     --profile P --run R --queue FILE [--result-schema FILE] [--no-start]
 *   page-lab-gate nav     --run R
 *   page-lab-gate done    --run R --item HASH --result FILE
 *   page-lab-gate status  --run R
 *
 * Exit 0 ok / queue drained · 10 blocked, handoff needed · 11 cooldown, aborted ·
 *      12 profile locked by a live process that is not ours · 1 error · 2 usage.
 * (Checked against the plugin's other codes: EXIT_NO_TARGET=3, EXIT_UNSUPPORTED_NODE=7,
 * route-up 2, doctor 3.)
 *
 * Run state: ${XDG_STATE_HOME:-~/.local/state}/page-lab/runs/<run>/ — queue.jsonl, done.jsonl,
 * events.jsonl, cooldown.json, plus meta.json and cursor.json. Never in a repo, never in the
 * profile dir (that dir is Chromium's).
 *
 * The browser is the chrome-devtools CLI daemon from the pinned chrome-devtools-mcp, holding
 * Chromium over a pipe. Its argv comes from lib/profiles.mjs#dedicatedArgv — the same function
 * browser.sh uses — so the headless run and the headed handoff differ by one token only.
 */

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { buildBlock, formatErrors, loadBlockSchema, originOf, validate } from './lib/envelope.mjs';
import {
  COOLDOWN_ABORT_ORIGINS,
  RUN_ID_PATTERN,
  cooldownOrigins,
  decide,
  nextItem,
  parseDocumentStatus,
  parseNavigate,
  parseProbe,
  parseQueue,
  probeSource,
  recordBlock,
} from './lib/gate.mjs';
import {
  CDM_PACKAGE,
  ProfileError,
  dedicatedArgv,
  lockState,
  profileDir,
  resolveProfile,
  sessionIdFor,
  stateHome,
} from './lib/profiles.mjs';

export const EXIT = Object.freeze({ OK: 0, ERROR: 1, USAGE: 2, BLOCKED: 10, COOLDOWN: 11, LOCKED: 12 });

class GateExit extends Error {
  constructor(code, message, payload) {
    super(message);
    this.code = code;
    this.payload = payload;
  }
}

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

// ---------------------------------------------------------------------------
// Run files
// ---------------------------------------------------------------------------

function runDir(run) {
  if (!RUN_ID_PATTERN.test(run ?? '')) throw new GateExit(EXIT.USAGE, `--run must match ${RUN_ID_PATTERN}`);
  return join(stateHome(), 'page-lab', 'runs', run);
}

function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}

function writeJson(path, obj) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function appendJsonl(path, obj) {
  appendFileSync(path, `${JSON.stringify(obj)}\n`, { mode: 0o600 });
}

function openRun(run) {
  const dir = runDir(run);
  const meta = readJson(join(dir, 'meta.json'), null);
  if (!meta) throw new GateExit(EXIT.ERROR, `no run "${run}" — start one with page-lab-gate run`);
  const files = {
    dir,
    meta: join(dir, 'meta.json'),
    queue: join(dir, 'queue.jsonl'),
    done: join(dir, 'done.jsonl'),
    events: join(dir, 'events.jsonl'),
    cooldown: join(dir, 'cooldown.json'),
    cursor: join(dir, 'cursor.json'),
  };
  return {
    run,
    files,
    meta,
    profile: resolveProfile(meta.profile),
    queue: readJsonl(files.queue),
    done: new Set(readJsonl(files.done).map((d) => d.item)),
    cooldown: readJson(files.cooldown, {}),
    cursor: readJson(files.cursor, { cursor: 0 }).cursor,
  };
}

// ---------------------------------------------------------------------------
// The chrome-devtools CLI daemon
// ---------------------------------------------------------------------------

function cdt(profile, args, { timeout = 90_000 } = {}) {
  const r = spawnSync('npx', ['-y', '-p', CDM_PACKAGE, 'chrome-devtools', ...args], {
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      CD4A_INTERNAL_DAEMON_SESSION_ID: sessionIdFor(profile.name),
      // Otherwise every call fetches the npm registry's latest version.
      CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
    },
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** `status` is the only CLI call that never auto-starts a daemon; every other one does. */
function daemonStatus(profile) {
  const r = cdt(profile, ['status'], { timeout: 30_000 });
  if (!/daemon is running/.test(r.stdout)) return { running: false };
  const pid = Number(/pid=(\d+)/.exec(r.stdout)?.[1]);
  let args = [];
  try {
    args = JSON.parse(/^args=(.*)$/m.exec(r.stdout)?.[1] ?? '[]');
  } catch {
    args = [];
  }
  return { running: true, pid, args };
}

/**
 * Ours = launched with THIS profile's dir and the safety flags the closed argv always carries.
 * A daemon that answers on our session id with anything else (a hand-run `start`) is not ours.
 */
function daemonIsOurs(profile, st) {
  const need = [
    `--user-data-dir=${profileDir(profile.name)}`,
    '--no-category-emulation',
    '--no-category-extensions',
    '--redact-network-headers',
  ];
  return st.running && need.every((n) => st.args.includes(n));
}

function isDescendant(pid, ancestor) {
  let cur = pid;
  for (let i = 0; i < 8 && cur > 1; i++) {
    if (cur === ancestor) return true;
    const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(cur)], { encoding: 'utf8' });
    cur = Number((r.stdout ?? '').trim());
    if (!Number.isInteger(cur)) return false;
  }
  return cur === ancestor;
}

/**
 * The lock check, step 1 of every launch and of the handoff (§7.5). Chromium's own
 * SingletonLock is the source of truth — no second lock file of ours beside it.
 */
function checkLock(profile, st) {
  const l = lockState(profile.name);
  if (l.state === 'foreign') throw new GateExit(EXIT.LOCKED, `profile ${profile.name} locked from host ${l.host}`);
  if (l.state === 'held') {
    const ours = st.running && daemonIsOurs(profile, st) && isDescendant(l.pid, st.pid);
    if (!ours) throw new GateExit(EXIT.LOCKED, `profile ${profile.name} locked by pid ${l.pid}, not ours`);
    return { ...l, ours: true };
  }
  return l;
}

function requireOurDaemon(profile) {
  const st = daemonStatus(profile);
  if (!st.running) {
    throw new GateExit(EXIT.ERROR, `no ${profile.name} daemon — page-lab-gate resume --run <run> starts it`);
  }
  if (!daemonIsOurs(profile, st)) {
    throw new GateExit(EXIT.LOCKED, `the ${profile.name} daemon was not started by page-lab (args differ)`);
  }
  return st;
}

function prepareDir(profile) {
  const dir = profileDir(profile.name);
  mkdirSync(join(dir, '..'), { recursive: true, mode: 0o700 });
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  if (process.platform === 'darwin') spawnSync('tmutil', ['addexclusion', dir], { stdio: 'ignore' });
}

function startDaemon(profile, headless, workspace) {
  prepareDir(profile);
  const { argv } = dedicatedArgv(profile, { headless, workspace });
  const r = cdt(profile, ['start', ...argv]);
  if (r.code !== 0) throw new GateExit(EXIT.ERROR, `chrome-devtools start failed: ${r.stderr.trim()}`);
  return argv;
}

function json(r) {
  return r.code === 0 ? r.stdout.trim() : null;
}

function workingPage(profile) {
  const r = json(cdt(profile, ['list_pages', '--output-format', 'json']));
  try {
    const pages = JSON.parse(r).pages;
    return (pages.find((p) => p.selected) ?? pages[0]).id;
  } catch {
    throw new GateExit(EXIT.ERROR, 'list_pages returned no page');
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdRun(opts) {
  if (!opts.profile || !opts.queue) throw new GateExit(EXIT.USAGE, 'run needs --profile and --queue');
  const profile = resolveProfile(opts.profile);
  if (profile.mode !== 'dedicated') throw new GateExit(EXIT.USAGE, `${profile.name} is attach-mode; runs drive dedicated profiles only`);
  const dir = runDir(opts.run);
  if (existsSync(join(dir, 'meta.json'))) throw new GateExit(EXIT.USAGE, `run ${opts.run} exists — use resume`);
  const items = parseQueue(readFileSync(opts.queue, 'utf8'));
  if (items.length === 0) throw new GateExit(EXIT.USAGE, 'queue is empty');
  let resultSchema = null;
  if (opts['result-schema']) resultSchema = JSON.parse(readFileSync(opts['result-schema'], 'utf8'));

  const st = opts['no-start'] ? { running: false } : daemonStatus(profile);
  checkLock(profile, st);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, 'queue.jsonl'), items.map((i) => JSON.stringify(i)).join('\n') + '\n', { mode: 0o600 });
  writeJson(join(dir, 'cursor.json'), { cursor: 0 });
  writeJson(join(dir, 'cooldown.json'), {});
  writeJson(join(dir, 'meta.json'), {
    profile: profile.name,
    createdAt: new Date().toISOString(),
    resultSchema,
  });

  let started = false;
  if (!opts['no-start']) {
    if (st.running && !daemonIsOurs(profile, st)) throw new GateExit(EXIT.LOCKED, 'daemon on this session is not ours');
    if (!st.running) {
      startDaemon(profile, profile.headless !== false, dir);
      started = true;
    }
  }
  out({ run: opts.run, profile: profile.name, items: items.length, dir, started });
}

function blockAndExit(r, q, decision, notes = []) {
  const now = Date.now();
  const event = buildBlock({
    url: q.url,
    reason: decision.reason,
    evidence: decision.evidence,
    profile: r.profile.name,
    runId: r.run,
    queuePos: q.queuePos,
    notes,
  });
  const v = validate(event, loadBlockSchema());
  if (!v.valid) {
    // The gate never writes an event its own schema rejects; that is a bug, not a block.
    throw new GateExit(EXIT.ERROR, `internal: block event invalid\n${formatErrors(v.errors).join('\n')}`);
  }
  appendJsonl(r.files.events, event);
  const state = recordBlock(r.cooldown, event.origin, now);
  writeJson(r.files.cooldown, r.cooldown);
  const cooling = cooldownOrigins(r.cooldown);
  if (cooling.length >= COOLDOWN_ABORT_ORIGINS) {
    throw new GateExit(EXIT.COOLDOWN, `${cooling.length} origins in cooldown — run aborted`, { event, originState: state });
  }
  throw new GateExit(EXIT.BLOCKED, `blocked: ${event.reason} (${event.evidence.rule}) — page-lab-gate handoff --run ${r.run}`, {
    event,
    originState: state,
  });
}

function cmdNav(opts) {
  const r = openRun(opts.run);
  const cooling = cooldownOrigins(r.cooldown);
  if (cooling.length >= COOLDOWN_ABORT_ORIGINS) {
    throw new GateExit(EXIT.COOLDOWN, `${cooling.length} origins in cooldown — run aborted`, { cooldown: cooling });
  }
  const pick = nextItem(r.queue, r.done, r.cooldown, r.cursor);
  if (!pick.next) {
    writeJson(r.files.cursor, { cursor: pick.cursor });
    // Whole-queue view, not just past the cursor: what is still pending, and why.
    const all = nextItem(r.queue, r.done, r.cooldown, 0);
    const pending = r.queue.filter((q) => !r.done.has(q.item)).length;
    if (all.held.blocked > 0) {
      throw new GateExit(EXIT.BLOCKED, `pending items wait on a blocked origin — page-lab-gate handoff --run ${r.run}`, {
        pending,
        held: all.held,
      });
    }
    if (all.held.cooldown > 0) {
      throw new GateExit(EXIT.COOLDOWN, 'every pending item is on an origin in cooldown', { pending, held: all.held });
    }
    out({ drained: true, pending, done: r.done.size });
    return;
  }
  const q = pick.next;
  // Before the cursor moves: a missing daemon must not silently skip an item. And before ANY
  // tool call: every CLI tool call on a stopped daemon auto-starts a DEFAULT one (default
  // profile dir, no redaction) — the gate never lets a tool call be what launches Chrome.
  requireOurDaemon(r.profile);
  writeJson(r.files.cursor, { cursor: pick.cursor });

  const page = workingPage(r.profile);
  // A non-front tab stalls (§7.6): bring the one working tab forward before EVERY navigation.
  cdt(r.profile, ['select_page', String(page), '--bringToFront']);
  const navR = cdt(r.profile, ['navigate_page', String(page), '--type', 'url', '--url', q.url, '--output-format', 'json']);
  if (navR.code !== 0) {
    blockAndExit(r, q, { reason: 'detector-error', evidence: { detector: 'final-url', rule: 'navigate-failed' } }, [
      'navigate_page exited non-zero (allowlist refusal, timeout or crash)',
    ]);
  }
  // NEVER trust navigate's "Successfully navigated" — it says so on a 403 and a 429 (measured).
  const statusR = cdt(r.profile, [
    'list_network_requests',
    String(page),
    '--resourceTypes',
    'document',
    '--output-format',
    'json',
  ]);
  const probeR = cdt(r.profile, [
    'evaluate_script',
    probeSource(),
    '--pageId',
    String(page),
    '--waitForStableDom',
    'false',
    '--output-format',
    'json',
  ]);
  const nav = parseNavigate(navR.stdout);
  const decision = decide({
    requestedUrl: q.url,
    nav,
    status: json(statusR) === null || !nav ? null : parseDocumentStatus(statusR.stdout, nav.finalUrl),
    probe: json(probeR) === null ? null : parseProbe(probeR.stdout),
  });
  if (!decision.ok) blockAndExit(r, q, decision);
  out({ ok: true, pageId: page, item: q.item, url: q.url, queuePos: q.queuePos });
}

function cmdDone(opts) {
  const r = openRun(opts.run);
  if (!opts.item || !opts.result) throw new GateExit(EXIT.USAGE, 'done needs --item and --result');
  const q = r.queue.find((x) => x.item === opts.item);
  if (!q) throw new GateExit(EXIT.USAGE, `no item ${opts.item} in run ${r.run}`);
  if (r.done.has(q.item)) {
    out({ done: q.item, already: true });
    return;
  }
  let result;
  try {
    result = JSON.parse(readFileSync(opts.result, 'utf8'));
  } catch (err) {
    throw new GateExit(EXIT.ERROR, `--result: not JSON — ${err.message}`);
  }
  if (r.meta.resultSchema) {
    const v = validate(result, r.meta.resultSchema);
    if (!v.valid) {
      // An item without a valid done stays pending, so resume redoes it.
      throw new GateExit(EXIT.ERROR, `result fails the run's schema\n${formatErrors(v.errors).join('\n')}`);
    }
  }
  appendJsonl(r.files.done, { item: q.item, url: q.url, at: new Date().toISOString(), result });
  out({ done: q.item });
}

function cmdStatus(opts) {
  const r = openRun(opts.run);
  out({
    run: r.run,
    profile: r.profile.name,
    items: r.queue.length,
    done: r.done.size,
    pending: r.queue.filter((q) => !r.done.has(q.item)).length,
    events: readJsonl(r.files.events).length,
    cursor: r.cursor,
    cooldown: Object.fromEntries(Object.entries(r.cooldown).map(([o, v]) => [o, v.state])),
    lock: lockState(r.profile.name).state,
  });
}

const COMMANDS = {
  run: cmdRun,
  nav: cmdNav,
  done: cmdDone,
  status: cmdStatus,
};

const FLAGS = new Set(['no-start']);

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new GateExit(EXIT.USAGE, `unexpected argument: ${a}`);
    const key = a.slice(2);
    if (FLAGS.has(key)) opts[key] = true;
    else {
      if (i + 1 >= rest.length) throw new GateExit(EXIT.USAGE, `${a} needs a value`);
      opts[key] = rest[++i];
    }
  }
  return { cmd, opts };
}

function main(argv) {
  try {
    const { cmd, opts } = parseArgs(argv);
    const fn = COMMANDS[cmd];
    if (!fn) {
      throw new GateExit(EXIT.USAGE, `usage: page-lab-gate {${Object.keys(COMMANDS).join('|')}} --run R …`);
    }
    if (cmd !== 'run' && !opts.run) throw new GateExit(EXIT.USAGE, `${cmd} needs --run`);
    fn(opts);
    return EXIT.OK;
  } catch (err) {
    if (err instanceof GateExit) {
      if (err.payload) out({ exit: err.code, ...err.payload });
      process.stderr.write(`page-lab-gate: ${err.message}\n`);
      return err.code;
    }
    if (err instanceof ProfileError) {
      process.stderr.write(`page-lab-gate: ${err.message}\n`);
      return EXIT.USAGE;
    }
    process.stderr.write(`page-lab-gate: ${err.stack || err.message}\n`);
    return EXIT.ERROR;
  }
}

process.exitCode = main(process.argv.slice(2));
