// The gate's PURE half: detector decisions, the probe, the queue and the cooldown arithmetic.
// No process, no browser, no clock of its own — every function takes what it needs, so
// tests/gate-decide.test.mjs pins each rule without launching anything. The impure half
// (the chrome-devtools CLI, the daemon, the lock) is scripts/page-lab-gate.mjs.
//
// Authority for WHICH pages stop is ../../references/gate-detectors.json. This file only reads
// it; a rule added here instead of there is the drift the data file exists to prevent.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { originOf } from './envelope.mjs';

export const DETECTORS_PATH = new URL('../../references/gate-detectors.json', import.meta.url);
export const PROBE_SCHEMA = 'page-lab/probe@1';
export const DAY_MS = 24 * 60 * 60 * 1000;
export const COOLDOWN_ABORT_ORIGINS = 3;
export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

let cached = null;
export function loadDetectors() {
  if (!cached) cached = JSON.parse(readFileSync(DETECTORS_PATH, 'utf8'));
  return cached;
}

/** Queue key: the URL hashed, so done.jsonl is keyed by something with no page text in it. */
export function itemHash(url) {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

/**
 * Queue input: one URL per line, or one {"url": ...} object per line. Blank lines and # comments
 * are skipped; duplicates are dropped (first wins). Anything else is an error naming the line.
 */
export function parseQueue(text) {
  const items = [];
  const seen = new Set();
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    let url = line;
    if (line.startsWith('{')) {
      try {
        url = JSON.parse(line).url;
      } catch {
        throw new Error(`queue line ${i + 1}: not JSON`);
      }
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`queue line ${i + 1}: not a URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`queue line ${i + 1}: only http(s) URLs are queued`);
    }
    const item = itemHash(parsed.href);
    if (seen.has(item)) return;
    seen.add(item);
    items.push({ item, url: parsed.href });
  });
  return items;
}

/**
 * The one fixed probe. Built from the detector data, so the selector list is versioned with
 * it; returns ONLY rule names. A selector that throws is reported as an error, which the
 * caller turns into a STOP.
 */
export function probeSource(rules = loadDetectors().probe.rules) {
  const spec = JSON.stringify(rules.map(({ name, selector }) => ({ name, selector })));
  return `() => {
  const rules = ${spec};
  const hits = [];
  for (const r of rules) {
    let els;
    try { els = Array.from(document.querySelectorAll(r.selector)); }
    catch (e) { return { probe: '${PROBE_SCHEMA}', error: 'bad-selector', rule: r.name }; }
    const hit = els.some((e) => e.tagName === 'SCRIPT' || e.tagName === 'IFRAME' || e.getClientRects().length > 0);
    if (hit) hits.push(r.name);
  }
  return { probe: '${PROBE_SCHEMA}', hits };
}`;
}

/**
 * evaluate_script --output-format json returns {message: "...```json\n<value>\n```"} — the
 * value is markdown-fenced INSIDE the JSON (measured, 1.12.0). Anything that does not unwrap
 * to {probe: page-lab/probe@1, hits: string[]} is null, and null STOPS.
 */
export function parseProbe(stdout) {
  try {
    const outer = JSON.parse(stdout);
    const m = /```json\n([\s\S]*?)\n```/.exec(String(outer?.message ?? ''));
    if (!m) return null;
    const v = JSON.parse(m[1]);
    if (v?.probe !== PROBE_SCHEMA || !Array.isArray(v.hits)) return null;
    if (!v.hits.every((h) => typeof h === 'string')) return null;
    return v;
  } catch {
    return null;
  }
}

/**
 * The main document's status from list_network_requests JSON. An iframe is a `document` request
 * too (measured: a challenge iframe's blocked load is listed after the page), so the main one is
 * the request whose URL is the page's FINAL URL, fragment ignored. No such request → null → STOP.
 */
export function parseDocumentStatus(stdout, finalUrl) {
  const strip = (u) => String(u).split('#')[0];
  try {
    const list = JSON.parse(stdout)?.networkRequests;
    if (!Array.isArray(list) || typeof finalUrl !== 'string') return null;
    const main = list.filter((r) => strip(r.url) === strip(finalUrl)).at(-1);
    if (!main) return null;
    const n = Number(main.status);
    return Number.isInteger(n) && n >= 100 && n <= 599 ? n : null;
  } catch {
    return null;
  }
}

/** navigate_page JSON → the selected page's final URL and title, or null. */
export function parseNavigate(stdout) {
  try {
    const pages = JSON.parse(stdout)?.pages;
    const sel = Array.isArray(pages) ? pages.find((p) => p.selected) ?? pages[0] : null;
    if (!sel || typeof sel.url !== 'string') return null;
    return { finalUrl: sel.url, title: typeof sel.title === 'string' ? sel.title : '' };
  } catch {
    return null;
  }
}

const stop = (reason, detector, rule, extra = {}) => ({ ok: false, reason, evidence: { detector, rule, ...extra } });

function hostMatches(host, suffix) {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * THE decision. signals = { requestedUrl, nav: {finalUrl,title}|null, status: int|null,
 * probe: {hits}|null }. Returns {ok:true} or {ok:false, reason, evidence}. Order is the
 * detector file's precedence; an unreadable signal is detector-error, never a pass.
 */
export function decide(signals, rules = loadDetectors()) {
  const { requestedUrl, nav, status, probe } = signals;

  if (status === null || status === undefined) return stop('detector-error', 'status', 'status-unreadable');
  const s = rules.status.find((r) => r.code === status);
  if (s) return stop(s.reason, 'status', s.name, { status });

  if (!nav) return stop('detector-error', 'final-url', 'navigate-unreadable');
  let fin;
  let req;
  try {
    fin = new URL(nav.finalUrl);
    req = new URL(requestedUrl);
  } catch {
    return stop('detector-error', 'final-url', 'final-url-unparseable');
  }
  if (fin.origin !== req.origin) {
    const id = rules.finalUrl.identityHosts.find((h) => hostMatches(fin.hostname, h.suffix));
    if (id) return stop('login-wall', 'final-url', id.name);
  }
  for (const lp of rules.finalUrl.loginPaths) {
    const re = new RegExp(lp.pattern, lp.flags ?? '');
    if (re.test(fin.pathname) && !re.test(req.pathname)) return stop('login-wall', 'final-url', lp.name);
  }

  for (const t of rules.title) {
    if (new RegExp(t.pattern, t.flags ?? '').test(nav.title)) return stop(t.reason, 'title', t.name);
  }

  if (!probe) return stop('detector-error', 'probe', 'probe-unparseable');
  for (const r of rules.probe.rules) {
    if (probe.hits.includes(r.name)) return stop(r.reason, 'probe', r.name);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Cooldown — slow down, never evade (§7.5). State per origin:
//   { blocks: [iso...], state: "blocked" | "cleared" | "cooldown", clearedAt? }
// blocked  = 1st block: that origin stops for this pass; resume (after a handoff) clears it.
// cooldown = 2nd block within 24 h: ONLY clear-cooldown, run by the human, ends it. No timer.
// ---------------------------------------------------------------------------

/** Record a block at `now`; returns the origin's new state. Mutates `cooldown`. */
export function recordBlock(cooldown, origin, now) {
  const prev = cooldown[origin] ?? { blocks: [], state: 'cleared' };
  const recent = prev.blocks.filter((t) => now - Date.parse(t) < DAY_MS);
  const entry = {
    ...prev,
    blocks: [...prev.blocks, new Date(now).toISOString()],
    state: prev.state === 'cooldown' || recent.length >= 1 ? 'cooldown' : 'blocked',
  };
  cooldown[origin] = entry;
  return entry.state;
}

export function cooldownOrigins(cooldown) {
  return Object.keys(cooldown).filter((o) => cooldown[o].state === 'cooldown');
}

/** resume: a handoff happened, so first-block stops are lifted. Cooldowns are NOT. */
export function liftBlocked(cooldown) {
  for (const o of Object.keys(cooldown)) if (cooldown[o].state === 'blocked') cooldown[o].state = 'cleared';
  return cooldown;
}

/** The human's clear: ends the cooldown and forgets its window, so the next block is a 1st. */
export function clearCooldown(cooldown, origin, now) {
  if (!cooldown[origin]) return false;
  cooldown[origin] = { blocks: [], state: 'cleared', clearedAt: new Date(now).toISOString() };
  return true;
}

/**
 * Next item from `cursor`: not done, origin neither blocked nor in cooldown. Returns
 * { next: {item,url,queuePos}|null, cursor, held: {blocked:n, cooldown:n} } where held counts the
 * pending items skipped because of their origin's state.
 */
export function nextItem(queue, done, cooldown, cursor) {
  const held = { blocked: 0, cooldown: 0 };
  for (let i = cursor; i < queue.length; i++) {
    const q = queue[i];
    if (done.has(q.item)) continue;
    const st = cooldown[originOf(q.url)]?.state;
    if (st === 'blocked' || st === 'cooldown') {
      held[st]++;
      continue;
    }
    return { next: { ...q, queuePos: i }, cursor: i + 1, held };
  }
  return { next: null, cursor: queue.length, held };
}
