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
 * The main document from list_network_requests JSON → { status, requestId }. An iframe is a
 * `document` request too (measured: a challenge iframe's blocked load is listed after the
 * page), so the main one is the request whose URL is the page's FINAL URL, fragment ignored
 * [F-NAV-SUCCESS-ON-403]. No such request, or no numeric status → null → STOP.
 */
export function parseMainDocument(stdout, finalUrl) {
  const strip = (u) => String(u).split('#')[0];
  try {
    const list = JSON.parse(stdout)?.networkRequests;
    if (!Array.isArray(list) || typeof finalUrl !== 'string') return null;
    const main = list.filter((r) => strip(r.url) === strip(finalUrl)).at(-1);
    if (!main) return null;
    const n = Number(main.status);
    if (!Number.isInteger(n) || n < 100 || n > 599) return null;
    return { status: n, requestId: main.requestId };
  } catch {
    return null;
  }
}

/** Back-compat shim for the status alone. */
export function parseDocumentStatus(stdout, finalUrl) {
  return parseMainDocument(stdout, finalUrl)?.status ?? null;
}

/**
 * get_network_request JSON → the ALLOWLISTED response headers only [F-REDACTED-HEADERS-KEEP-KEYS], keys lowercased, values as
 * the server saw them after redaction ("<redacted>" for cf-*). Anything else — set-cookie
 * included — is dropped here, before it can reach a decision or an event. null if unreadable.
 */
export function parseHeaders(stdout, allowlist = loadDetectors().headers.allowlist) {
  try {
    const raw = JSON.parse(stdout)?.networkRequest?.responseHeaders;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const key = k.toLowerCase();
      if (allowlist.includes(key) && typeof v === 'string') out[key] = v.replace(/[^\x20-\x7e]/g, '').slice(0, 200);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * The page title as evidence: capped at 120 chars, control characters stripped, and any
 * token-like run (24+ base64/hex-ish chars) redacted — a title can echo a session id.
 */
export function safeTitle(title) {
  return String(title ?? '')
    .replace(/[^\x20-\x7e\u00a0-\uffff]/g, '')
    .replace(/[A-Za-z0-9+/_=-]{24,}/g, '[redacted]')
    .slice(0, 120);
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

function hostMatches(host, suffix) {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * THE decision. signals = { requestedUrl, nav: {finalUrl,title}|null, status: int|null,
 * headers: {allowlisted}|null, probe: {hits}|null }. Returns {ok:true} or
 * {ok:false, reason, evidence}. Order is the detector file's precedence; an unreadable signal
 * is detector-error, never a pass. Evidence always carries what was READ — status, the
 * allowlisted headers, the capped title — plus the rule name; never markup, never a cookie.
 */
export function decide(signals, rules = loadDetectors()) {
  const { requestedUrl, nav, status, headers, probe } = signals;
  const seen = {};
  if (Number.isInteger(status)) seen.status = status;
  if (headers && Object.keys(headers).length) seen.headers = { ...headers };
  if (nav) seen.title = safeTitle(nav.title);
  const stop = (reason, detector, rule) => ({ ok: false, reason, evidence: { detector, rule, ...seen } });

  if (status === null || status === undefined) return stop('detector-error', 'status', 'status-unreadable');
  const s = rules.status.find((r) => r.code === status);
  if (s) return stop(s.reason, 'status', s.name);

  if (!headers) return stop('detector-error', 'headers', 'headers-unreadable');
  const h = rules.headers.stop.find((r) => r.header in headers);
  if (h) return stop(h.reason, 'headers', h.name);

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
    const id = rules.finalUrl.identityHosts.find((x) => hostMatches(fin.hostname, x.suffix));
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
  const c = rules.probe.corroboration;
  const corroborated = status >= c.minStatus || c.headers.some((k) => k in headers);
  for (const r of rules.probe.rules) {
    if (!probe.hits.includes(r.name)) continue;
    if (r.corroborate && !corroborated) continue; // a beacon or a form's widget on a normal page
    return stop(r.reason, 'probe', r.name);
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

// ---------------------------------------------------------------------------
// Egress preflight (§7.7) — where the BROWSER's traffic leaves, measured through the browser.
// A managed challenge was once caused by VPN egress in an unexpected country (peer
// measurement, site-agnostic); refusing on an unexpected egress prevented it. The trace body
// carries the caller's IP: it is filtered IN THE PAGE to EGRESS_FIELDS, so `ip` never reaches
// node, stdout, an event or a run file — and parseEgress rejects any other key anyway.
// ---------------------------------------------------------------------------

export const EGRESS_SCHEMA = 'page-lab/egress@1';
export const EGRESS_TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
export const EGRESS_FIELDS = Object.freeze(['loc', 'colo', 'warp', 'gateway', 'http', 'tls']);
export const EGRESS_RECHECK_MS = 10 * 60 * 1000;

/**
 * The trace URL. PAGE_LAB_EGRESS_TRACE_URL is honoured ONLY when it points at 127.0.0.1 (the
 * test fixture server), so production can never be redirected to a host that answers "CA"
 * whatever the egress is. Returns { url, overridden, ignored }.
 */
export function traceUrl(env = process.env) {
  const raw = env.PAGE_LAB_EGRESS_TRACE_URL;
  if (!raw) return { url: EGRESS_TRACE_URL, overridden: false, ignored: false };
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' && u.hostname === '127.0.0.1') return { url: u.href, overridden: true, ignored: false };
  } catch {
    // fall through: an unparseable override is ignored like a non-local one
  }
  return { url: EGRESS_TRACE_URL, overridden: false, ignored: true };
}

/** key=value lines → only the EGRESS_FIELDS, each capped. The SAME code runs in the page. */
export function filterTrace(text, fields = EGRESS_FIELDS) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (fields.includes(k)) out[k] = line.slice(i + 1).trim().slice(0, 32);
  }
  return out;
}

/** The fixed evaluate_script body: reads the trace page's text and returns ONLY the allowed keys. */
export function egressSource(fields = EGRESS_FIELDS) {
  return `() => {
  const filterTrace = ${filterTrace.toString()};
  const text = document.body ? document.body.innerText : '';
  return { egress: '${EGRESS_SCHEMA}', fields: filterTrace(text, ${JSON.stringify(fields)}) };
}`;
}

/**
 * evaluate_script JSON → the egress fields, or null (unparseable, no loc, an unknown key, or a
 * value that is not short printable ASCII). null with a policy present STOPS: fail closed.
 */
export function parseEgress(stdout, fields = EGRESS_FIELDS) {
  try {
    const outer = JSON.parse(stdout);
    const m = /```json\n([\s\S]*?)\n```/.exec(String(outer?.message ?? ''));
    if (!m) return null;
    const v = JSON.parse(m[1]);
    if (v?.egress !== EGRESS_SCHEMA || !v.fields || typeof v.fields !== 'object' || Array.isArray(v.fields)) return null;
    const out = {};
    for (const [k, val] of Object.entries(v.fields)) {
      if (!fields.includes(k)) return null;
      if (typeof val !== 'string' || !/^[\x21-\x7e]{1,32}$/.test(val)) return null;
      out[k] = val;
    }
    // Two characters, not two letters: Cloudflare's country field uses XX (unknown) and T1 (Tor).
    if (!/^[A-Z0-9]{2}$/.test(out.loc ?? '')) return null;
    return out;
  } catch {
    return null;
  }
}

/**
 * Is a recheck due? No check yet, an unreadable timestamp, one ≥ EGRESS_RECHECK_MS old, a check
 * that did not PASS (a refused egress must be re-measured, never remembered as a pass), or one
 * taken under a different enforcement than now (a policy added mid-run).
 */
export function egressDue(last, now, enforced) {
  const t = Date.parse(last?.at ?? '');
  if (!Number.isFinite(t) || now - t >= EGRESS_RECHECK_MS) return true;
  return last.pass !== true || last.enforced !== Boolean(enforced);
}

export function egressEnforced(policy) {
  return Boolean(policy && (policy.allowLoc?.length || policy.allowWarp?.length));
}

/**
 * fields (parseEgress output, or null) × the profile's `egress` policy (or undefined) →
 *   { ok: true, enforced } · { ok: false, reason, rule, evidence }
 * evidence carries loc/colo/warp only — never ip, never any other field. No policy: never
 * refuses (the caller prints a one-line note), even when the trace was unreadable.
 */
export function decideEgress(fields, policy) {
  if (!egressEnforced(policy)) return { ok: true, enforced: false };
  if (!fields) return { ok: false, reason: 'detector-error', rule: 'egress-trace-unreadable', evidence: {} };
  // Evidence is cut to the block schema's shape HERE: a colo or warp the schema cannot carry is
  // omitted, so a real mismatch still writes its event and exits 13 instead of failing validation.
  const evidence = { loc: fields.loc };
  if (/^[A-Z]{3,4}$/.test(fields.colo ?? '')) evidence.colo = fields.colo;
  if (['off', 'on', 'plus'].includes(fields.warp)) evidence.warp = fields.warp;
  if (policy.allowLoc?.length && !policy.allowLoc.includes(fields.loc)) {
    return { ok: false, reason: 'egress-mismatch', rule: 'egress.loc', evidence };
  }
  if (policy.allowWarp?.length && !policy.allowWarp.includes(fields.warp)) {
    return { ok: false, reason: 'egress-mismatch', rule: 'egress.warp', evidence };
  }
  return { ok: true, enforced: true };
}
