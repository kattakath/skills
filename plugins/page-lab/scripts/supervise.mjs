#!/usr/bin/env node
// Supervised driving: the agent drives the operator's Chromium while the operator watches,
// and control changes hands only when needed.
//
// Same two-way page<->agent bridge as the picker, same pieces: one raw CDP socket
// (lib/cdp.mjs), a Runtime.addBinding callback from the page [cdp-extras.md], a detached
// process that holds the socket so the injection outlives the caller (pick-watchdog.mjs's
// pattern), and a stamp file in tmpdir as the one source of truth. Nothing here is a second
// mechanism; only the payload (supervise-overlay.js) is new.
//
//   start | stop | state | wait | pass | arm | open | need-human     (see HELP)
//
// stdout: one JSON object (state/need-human/pass). stderr: everything a human reads.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, browserSocket, connect, pageTargets } from './lib/cdp.mjs';
import { documentStartSource } from './lib/harness.mjs';

const EXIT = { OK: 0, USAGE: 1, HUMAN: 10, INTERVENE: 11, NOT_RUNNING: 12, STILL_HUMAN: 20 };

const STAMP = join(tmpdir(), 'page-lab-supervise.json');
const STATE_DIR = join(tmpdir(), 'page-lab-supervise');
const OVERLAY = readFileSync(fileURLToPath(new URL('./supervise-overlay.js', import.meta.url)), 'utf8');
const RAISE_TTL_MS = 10 * 60 * 1000;
const HB_MS = 1500;

const HELP = `Usage: supervise.mjs <command> [options]

  start [--browser-url U] [--ttl-min N]   spawn the detached daemon; overlay ON (state agent)
  stop                                    remove overlay + injection everywhere, end the daemon
  state [--json]                          print agent|human|intervene|stopped (a file read)
  wait [--timeout S]                      block until state is agent (default 540 s)
  pass [--ms N] [--keys Escape]           open a passthrough window on every page (CLI form of
                                          __pageLab.pass; prefer evaluate_script on the tab you drive)
  arm [--force]                           state -> agent (refuses while human, unless --force)
  open <url>                              open a tab in the BACKGROUND (never raises the window);
                                          remembers it as the tab need-human will target
  need-human --reason "..." [--tab T] [--until U] [--timeout S] [--esc-ends] [--no-alert] [--no-rearm]
                                          hand control to the operator ON ONE TAB: bring that tab
                                          to the front, show the banner there, alert, watch, return

  --tab:   a targetId or a URL substring. Omitted: the tab most recently opened (\`open\`) or driven
           (\`__pageLab.pass\`) by the agent, NEVER the visible one. No such tab: exit 1, nothing shown.
  --until: 'url:<regex>' | 'sel:<css>', evaluated on THAT tab only; bare = url regex if it has '://'
           or starts with ^, else a selector. This is the default resolution; the banner's Done button
           is only the fallback.
  --no-alert: no sound or notification. The tab is STILL brought forward (that is the point).
  need-human is for steps only a human can do (MFA/TOTP, passkey/Touch ID, Google re-auth, captcha).
  Never use it to confirm a decision already taken in conversation.

Exit: 0 ok · 10 state is human · 11 state is intervene · 12 daemon not running
      20 need-human/wait timed out and the operator STILL has control (re-invoke, do not act)
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stderr.write(`${s}\n`);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// stamp: the one source of truth, atomically replaced
// ---------------------------------------------------------------------------

function readStamp() {
  try {
    return JSON.parse(readFileSync(STAMP, 'utf8'));
  } catch {
    return null;
  }
}
function writeStamp(patch) {
  const next = { ...(readStamp() ?? {}), ...patch, at: Date.now() };
  const tmp = `${STAMP}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  renameSync(tmp, STAMP);
  return next;
}
const running = (s = readStamp()) => Boolean(s && s.pid && alive(s.pid));

// ---------------------------------------------------------------------------
// page-side calls
// ---------------------------------------------------------------------------

async function evalIn(client, sessionId, expression) {
  const r = await client.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: false },
    sessionId,
    { timeout: 4000 },
  );
  return r.exceptionDetails ? undefined : r.result?.value;
}
// An intervention belongs to ONE tab: only s.target shows the banner, every other tab is merely
// told the operator is needed (pass() refuses there too). No target = whole-browser, as before.
const setExpr = (s, targetId) => {
  const mine = s.state !== 'intervene' || !s.target || s.target === targetId;
  return `window.__pageLab&&window.__pageLab._hb(${JSON.stringify(s.state)},${JSON.stringify(s.reason ?? '')},${Boolean(s.escEnds)},${mine})`;
};

/** Run fn(client, sessionId, target) on every page target, each independently guarded. */
async function forEachPage(client, fn) {
  const out = [];
  for (const t of await pageTargets(client)) {
    try {
      const sessionId = await attach(client, t.targetId);
      out.push(await fn(client, sessionId, t));
    } catch (e) {
      log(`[supervise] ${t.url}: ${e?.message || e}`);
    }
  }
  return out;
}

async function withBrowser(fn) {
  const browserUrl = readStamp()?.browserUrl ?? 'http://127.0.0.1:9222';
  const client = await connect(await browserSocket(browserUrl));
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

async function broadcast() {
  const s = readStamp();
  if (!s) return;
  await withBrowser((c) => forEachPage(c, (cl, sid, t) => evalIn(cl, sid, setExpr(s, t.targetId))));
}

// ---------------------------------------------------------------------------
// daemon
// ---------------------------------------------------------------------------

async function daemon(opts) {
  const client = await connect(await browserSocket(opts.browserUrl));
  const sessions = new Map(); // sessionId -> {targetId, scriptId}
  const seen = new Set(); // targetIds already attached: discovery replays existing targets

  const attachTab = async (targetId, url) => {
    if (seen.has(targetId) || /^(devtools|chrome|chrome-extension):/.test(url || '')) return;
    seen.add(targetId);
    const sessionId = await attach(client, targetId);
    const slot = { targetId, scriptId: null };
    sessions.set(sessionId, slot);
    await client.send('Page.enable', {}, sessionId);
    await client.send('Runtime.enable', {}, sessionId);
    await client.send('Runtime.addBinding', { name: '__pageLabSignal' }, sessionId);
    const added = await client.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: documentStartSource(OVERLAY) },
      sessionId,
    );
    slot.scriptId = added.identifier;
    // The script above runs on the NEXT document only [F-DOCSTART-NEXT-NAV]; this is the open one.
    await evalIn(client, sessionId, documentStartSource(OVERLAY));
    await evalIn(client, sessionId, setExpr(readStamp() ?? { state: 'pending' }, targetId));
  };

  client.on('Target.targetCreated', ({ targetInfo: t }) => {
    if (t.type === 'page') attachTab(t.targetId, t.url).catch((e) => log(`attach: ${e.message}`));
  });
  client.on('Target.detachedFromTarget', ({ sessionId }) => {
    const slot = sessions.get(sessionId);
    if (slot) seen.delete(slot.targetId);
    sessions.delete(sessionId);
  });

  client.on('Runtime.bindingCalled', ({ name, payload }, sessionId) => {
    if (name !== '__pageLabSignal') return;
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch {
      return; // a payload we cannot parse is not a signal we can act on
    }
    const cur = readStamp() ?? {};
    if (msg.ev === 'hello') {
      void evalIn(client, sessionId, setExpr(cur, sessions.get(sessionId)?.targetId));
      return;
    }
    if (msg.ev === 'driven') {
      // The agent armed a window on this tab: it is the one need-human should target by default.
      const slot = sessions.get(sessionId);
      if (slot && cur.lastTab !== slot.targetId) writeStamp({ lastTab: slot.targetId });
      return;
    }
    let patch = null;
    if (msg.ev === 'barge-in') patch = { state: 'human', reason: '', resolved: null };
    else if (msg.ev === 'hand-back') patch = { state: 'agent', reason: '', resolved: null };
    else if (msg.ev === 'done' || msg.ev === 'esc-done') {
      // need-human is the one that re-arms; if nobody is waiting, hand straight back.
      patch = alive(cur.waiterPid ?? 0)
        ? { resolved: msg.ev === 'done' ? 'done' : 'esc' }
        : { state: 'agent', reason: '', resolved: null };
    }
    if (!patch) return;
    const s = writeStamp(patch);
    for (const [sid, slot] of sessions) void evalIn(client, sid, setExpr(s, slot.targetId)).catch(() => {});
  });

  await client.send('Target.setDiscoverTargets', { discover: true });
  for (const t of await pageTargets(client)) {
    await attachTab(t.targetId, t.url).catch((e) => log(`attach ${t.url}: ${e.message}`));
  }
  writeStamp({ pid: process.pid, browserUrl: opts.browserUrl, ready: true, startedAt: Date.now() });

  const hardStop = Date.now() + opts.ttlMin * 60000;
  const teardown = async () => {
    // Every override ships with its clear, each guarded alone: relying on the socket close to
    // undo them is exactly what facts.md forbids [F-UNMEASURED-DISCONNECT-RESET].
    for (const [sid, slot] of sessions) {
      await evalIn(client, sid, 'window.__pageLab&&window.__pageLab._destroy()').catch(() => {});
      if (slot.scriptId) {
        await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: slot.scriptId }, sid).catch(() => {});
      }
      await client.send('Runtime.removeBinding', { name: '__pageLabSignal' }, sid).catch(() => {});
    }
    try {
      unlinkSync(STAMP);
    } catch {
      /* already gone */
    }
  };
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => void teardown().finally(() => process.exit(0)));
  }

  for (;;) {
    if (client.closed || Date.now() > hardStop || readStamp()?.pid !== process.pid) break;
    const s = readStamp() ?? { state: 'pending' };
    for (const [sid, slot] of sessions) void evalIn(client, sid, setExpr(s, slot.targetId)).catch(() => {});
    await sleep(HB_MS);
  }
  await teardown();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

function parse(argv) {
  const o = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('--')) {
      const k = a.slice(2);
      const bool = ['json', 'force', 'esc-ends', 'no-alert', 'no-rearm'].includes(k);
      o.flags[k] = bool ? true : argv[++i];
      if (!bool && o.flags[k] === undefined) throw new Error(`${a} needs a value`);
    } else o._.push(a);
  }
  return o;
}

async function startDaemon(browserUrl = 'http://127.0.0.1:9222', ttlMin = 120) {
  const cur = readStamp();
  if (running(cur) && cur.ready) return cur;
  try {
    unlinkSync(STAMP);
  } catch {
    /* none */
  }
  // `open` may have run before the daemon existed; the remembered tab must survive the restart.
  if (cur?.lastTab) writeStamp({ lastTab: cur.lastTab });
  const wsFlag = process.execArgv.includes('--experimental-websocket') ? ['--experimental-websocket'] : [];
  const child = spawn(
    process.execPath,
    [...wsFlag, fileURLToPath(import.meta.url), '__daemon', '--browser-url', browserUrl, '--ttl-min', String(ttlMin)],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  for (let i = 0; i < 50; i += 1) {
    await sleep(200);
    const s = readStamp();
    if (s?.ready && running(s)) {
      // Fresh daemon: the overlay goes on unless a human already holds control.
      return writeStamp({ state: s.state ?? 'agent', reason: '', resolved: null });
    }
  }
  throw new Error('daemon did not come up in 10 s (is the debug browser on ' + browserUrl + '?)');
}

const stateExit = (s) => (!running(s) ? EXIT.NOT_RUNNING : s.state === 'human' ? EXIT.HUMAN : s.state === 'intervene' ? EXIT.INTERVENE : EXIT.OK);

// macOS side effects: guarded by platform, argv-only (the reason is never interpolated into script text).
function debugBrowserApp() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('/usr/bin/pgrep', ['-fl', '--', '--remote-debugging-port'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split('\n')) {
      const m = line.match(/\/([^/\s]*?)\.app\//);
      if (m) return m[1];
    }
  } catch {
    /* pgrep exits 1 on no match */
  }
  return null;
}
// The sound is separate from the banner: a notification posts as Script Editor and is silent
// when that app's notifications are blocked, so afplay carries the alert. Backgrounded, so it
// never blocks the watch loop; `say` only if afplay itself fails.
function playAlert() {
  const say = () => spawn('/usr/bin/say', ['-v', 'Samantha', 'Claude needs you'], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  const p = spawn('/usr/bin/afplay', ['/System/Library/Sounds/Glass.aiff'], { stdio: 'ignore', detached: true });
  p.on('error', say);
  p.on('close', (code) => { if (code) say(); });
  p.unref();
}
function notify(title, body) {
  if (process.platform !== 'darwin' || process.env.PAGE_LAB_SUPERVISE_NO_OSASCRIPT) return;
  playAlert();
  try {
    execFileSync('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv)', '-e', 'end run', body, title], { stdio: 'ignore', timeout: 8000 });
  } catch (e) {
    log(`[supervise] notification failed: ${e?.message || e}`);
  }
}
/** The app that is frontmost right now, by name; null where it cannot be told (non-macOS, no probe). */
function frontmostApp() {
  if (process.platform !== 'darwin' || process.env.PAGE_LAB_SUPERVISE_NO_OSASCRIPT) return null;
  try {
    const asn = execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const info = execFileSync('/usr/bin/lsappinfo', ['info', '-only', 'name', asn], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return (info.match(/^"([^"]+)"/) ?? [])[1] ?? null;
  } catch {
    return null;
  }
}
/** True the first time per reason per 10 min. The stamp is written BEFORE the raise it licenses. */
function raiseAllowed(reason) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const f = join(STATE_DIR, `raised-${createHash('sha1').update(reason).digest('hex').slice(0, 12)}`);
  try {
    if (Date.now() - statSync(f).mtimeMs < RAISE_TTL_MS) return false;
  } catch {
    /* never raised for this reason */
  }
  writeFileSync(f, String(Date.now()));
  return true;
}
function raiseApp(app) {
  if (!app) return 'no-browser-app';
  if (process.env.PAGE_LAB_SUPERVISE_NO_OSASCRIPT) return `dry-run:${app}`; // test seam: never raises
  try {
    execFileSync('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'tell application (item 1 of argv) to activate', '-e', 'end run', app], { stdio: 'ignore', timeout: 8000 });
    return 'raised';
  } catch (e) {
    return `raise-failed: ${e?.message || e}`;
  }
}
/**
 * Make `targetId` the selected tab. This is THE sanctioned raise: Target.activateTarget also brings
 * the window forward [F-SUPERVISE-FOCUS-TABLE], so it is gated like the OS-level raise, once per
 * reason per 10 min. One exception costs nothing: when the browser is already the frontmost app the
 * tab switch steals nothing, so a repeat call (the operator wandered to another tab) still lands on
 * the right tab. Returns {raised, activated}.
 */
async function bringTabForward(targetId, reason, { osRaise }) {
  const activate = () => withBrowser((c) => c.send('Target.activateTarget', { targetId }));
  const app = debugBrowserApp();
  if (app && frontmostApp() === app) {
    await activate();
    return { raised: 'already-frontmost', activated: true };
  }
  if (!raiseAllowed(reason)) return { raised: 'suppressed-already-raised', activated: false };
  await activate();
  return { raised: osRaise ? raiseApp(app) : 'tab-only', activated: true };
}

/** Pick the tab an intervention is about. Never falls back to "whatever is visible". */
async function resolveTab(client, spec, lastTab) {
  const pages = (await pageTargets(client)).filter((t) => !/^(chrome|chrome-extension):/.test(t.url || ''));
  const list = () => pages.map((t) => `  ${t.targetId}  ${t.url}`).join('\n') || '  (no pages)';
  if (spec) {
    const exact = pages.find((t) => t.targetId === spec);
    if (exact) return exact;
    const hits = pages.filter((t) => (t.url || '').includes(spec));
    if (hits.length === 1) return hits[0];
    const pref = hits.find((t) => t.targetId === lastTab);
    if (hits.length > 1 && pref) return pref;
    throw new Error(`--tab "${spec}" ${hits.length ? 'matches several tabs' : 'matches no tab'}; pass a targetId or a longer URL fragment:\n${list()}`);
  }
  if (!lastTab) {
    throw new Error(`need-human needs a tab: pass --tab <targetId|url-substring>, or open/drive one first (\`open <url>\`, \`__pageLab.pass\`). The visible tab is never assumed:\n${list()}`);
  }
  const t = pages.find((p) => p.targetId === lastTab);
  if (!t) throw new Error(`the tab last opened or driven (${lastTab}) is gone; pass --tab <targetId|url-substring>:\n${list()}`);
  return t;
}

function parseUntil(raw) {
  if (!raw) return null;
  if (raw.startsWith('url:')) return { kind: 'url', re: new RegExp(raw.slice(4)) };
  if (raw.startsWith('sel:')) return { kind: 'sel', sel: raw.slice(4) };
  return raw.includes('://') || raw.startsWith('^') ? { kind: 'url', re: new RegExp(raw) } : { kind: 'sel', sel: raw };
}

/** Does `until` hold ON THE TARGET TAB? (A URL elsewhere, or a selector in another tab, is not the login.) */
async function untilHolds(client, until, targetId) {
  const t = (await pageTargets(client)).find((p) => p.targetId === targetId);
  if (!t) return 'tab-closed';
  if (until.kind === 'url') return until.re.test(t.url || '');
  const sid = await attach(client, targetId);
  return Boolean(await evalIn(client, sid, `Boolean(document.querySelector(${JSON.stringify(until.sel)}))`));
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function needHuman(f) {
  const reason = String(f.reason ?? '').trim();
  if (!reason) throw new Error('need-human requires --reason "..."');
  const until = parseUntil(f.until);
  const timeoutMs = (Number(f.timeout ?? 540) || 540) * 1000;
  const wasHuman = readStamp()?.state === 'human';
  await startDaemon();
  // Resolve the tab BEFORE any side effect: a wrong or missing tab must not flash a banner anywhere.
  const tab = await withBrowser((c) => resolveTab(c, f.tab, readStamp()?.lastTab));
  // Bring the tab forward BEFORE the banner: the banner on a hidden tab is the bug this fixes.
  const fwd = await bringTabForward(tab.targetId, reason, { osRaise: !f['no-alert'] });
  writeStamp({ state: 'intervene', reason, target: tab.targetId, lastTab: tab.targetId, escEnds: Boolean(f['esc-ends']), resolved: null, waiterPid: process.pid });
  await broadcast();
  log(`[supervise] intervene on ${tab.targetId} (${tab.url}): ${reason}`);
  if (!f['no-alert']) notify('Claude needs you', reason);
  const t0 = Date.now();
  const client = await connect(await browserSocket(readStamp().browserUrl));
  let resolved = null;
  try {
    while (Date.now() - t0 < timeoutMs) {
      const s = readStamp();
      if (!running(s)) throw new Error('daemon died while waiting; overlay fails open on its own');
      if (s.resolved) {
        resolved = s.resolved;
        break;
      }
      if (until) {
        const held = await untilHolds(client, until, tab.targetId).catch(() => false);
        if (held) {
          resolved = held === 'tab-closed' ? 'tab-closed' : 'until';
          break;
        }
      }
      await sleep(500);
    }
  } finally {
    client.close();
  }
  const url = await withBrowser(async (c) => (await pageTargets(c)).map((t) => t.url));
  const base = { waitedMs: Date.now() - t0, raised: fwd.raised, tab: { targetId: tab.targetId, activated: fwd.activated } };
  if (!resolved) {
    // The operator still has control: leave the banner up, say so by exit code.
    writeStamp({ waiterPid: null });
    process.stdout.write(`${JSON.stringify({ resolved: null, state: 'intervene', ...base })}\n`);
    return EXIT.STILL_HUMAN;
  }
  // A prior barge-in (human) stays human: the operator never handed control back.
  const next = wasHuman && resolved === 'until' ? 'human' : f['no-rearm'] ? 'human' : 'agent';
  writeStamp({ state: next, reason: '', target: null, resolved: null, waiterPid: null });
  await broadcast();
  process.stdout.write(`${JSON.stringify({ resolved, state: next, ...base, urls: url })}\n`);
  return next === 'agent' ? EXIT.OK : EXIT.HUMAN;
}

async function main() {
  const o = parse(process.argv.slice(2));
  const cmd = o._[0];
  if (o.help || !cmd) {
    process.stdout.write(HELP);
    return cmd ? EXIT.OK : EXIT.USAGE;
  }
  const f = o.flags;
  switch (cmd) {
    case '__daemon':
      await daemon({ browserUrl: f['browser-url'], ttlMin: Number(f['ttl-min']) || 120 });
      return EXIT.OK;
    case 'start': {
      const s = await startDaemon(f['browser-url'], Number(f['ttl-min']) || 120);
      await broadcast();
      process.stdout.write(`${JSON.stringify({ state: s.state, pid: s.pid })}\n`);
      return EXIT.OK;
    }
    case 'stop': {
      const s = readStamp();
      if (running(s)) {
        try {
          process.kill(s.pid, 'SIGTERM');
        } catch {
          /* raced its own exit */
        }
        for (let i = 0; i < 25 && alive(s.pid); i += 1) await sleep(200);
      }
      try {
        unlinkSync(STAMP);
      } catch {
        /* already gone */
      }
      process.stdout.write('{"state":"stopped"}\n');
      return EXIT.OK;
    }
    case 'state': {
      const s = readStamp();
      const st = running(s) ? s.state : 'stopped';
      process.stdout.write(f.json ? `${JSON.stringify({ state: st, reason: s?.reason ?? '' })}\n` : `${st}\n`);
      return stateExit(s);
    }
    case 'wait': {
      const end = Date.now() + (Number(f.timeout ?? 540) || 540) * 1000;
      for (;;) {
        const s = readStamp();
        if (!running(s)) return EXIT.NOT_RUNNING;
        if (s.state === 'agent') {
          process.stdout.write('{"state":"agent"}\n');
          return EXIT.OK;
        }
        if (Date.now() > end) {
          process.stdout.write(`${JSON.stringify({ state: s.state })}\n`);
          return EXIT.STILL_HUMAN;
        }
        await sleep(500);
      }
    }
    case 'pass': {
      const s = readStamp();
      if (!running(s)) return EXIT.NOT_RUNNING;
      // cli:true — the all-pages form must not register every tab as "driven" (see overlay pass()).
      const keys = JSON.stringify({ cli: true, ...(f.keys ? { keys: String(f.keys).split(',') } : {}) });
      const res = await withBrowser((c) =>
        forEachPage(c, (cl, sid) => evalIn(cl, sid, `JSON.stringify(window.__pageLab&&window.__pageLab.pass(${Number(f.ms ?? 6000)},${keys}))`)),
      );
      const oks = res.map((r) => (r ? JSON.parse(r) : null)).filter(Boolean);
      process.stdout.write(`${JSON.stringify({ ok: oks.length > 0 && oks.every((r) => r.ok), pages: oks.length })}\n`);
      return oks.every((r) => r.ok) ? EXIT.OK : stateExit(s);
    }
    case 'arm': {
      const s = readStamp();
      if (!running(s)) return EXIT.NOT_RUNNING;
      if (s.state === 'human' && !f.force) {
        log('[supervise] the operator has control; only they (or --force) hand it back');
        return EXIT.HUMAN;
      }
      writeStamp({ state: 'agent', reason: '', resolved: null });
      await broadcast();
      process.stdout.write('{"state":"agent"}\n');
      return EXIT.OK;
    }
    case 'open': {
      const url = o._[1];
      if (!url) throw new Error('open needs a url');
      const targetId = await withBrowser(async (c) => (await c.send('Target.createTarget', { url, background: true })).targetId);
      writeStamp({ lastTab: targetId }); // need-human's default target; written even before the daemon exists
      process.stdout.write(`${JSON.stringify({ targetId })}\n`);
      return EXIT.OK;
    }
    case 'need-human':
      return needHuman(f);
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    log(`supervise: ${e?.message || e}`);
    process.exit(EXIT.USAGE);
  },
);
