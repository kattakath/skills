// The detectors, without a browser: every rule in references/gate-detectors.json fires on its
// signal, an unreadable signal STOPS (fail closed), and an ordinary page passes. This is the
// CI-safe half; tests/gate-live.test.mjs runs the same rules through a real browser.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadBlockSchema, buildBlock, validate } from '../scripts/lib/envelope.mjs';
import {
  clearCooldown,
  cooldownOrigins,
  decide,
  liftBlocked,
  loadDetectors,
  nextItem,
  parseDocumentStatus,
  parseProbe,
  parseQueue,
  probeSource,
  recordBlock,
} from '../scripts/lib/gate.mjs';

const U = 'https://example.com/page';
const ok = { requestedUrl: U, nav: { finalUrl: U, title: 'fine' }, status: 200, probe: { hits: [] } };
const fenced = (v) => JSON.stringify({ message: `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\`` });

test('an ordinary 200 page passes', () => assert.deepEqual(decide(ok), { ok: true }));

test('status 403 / 429 / 503 stop, with the status as evidence', () => {
  for (const code of [403, 429, 503]) {
    const d = decide({ ...ok, status: code });
    assert.equal(d.reason, `http-${code}`);
    assert.deepEqual(d.evidence, { detector: 'status', rule: `status.${code}`, status: code });
  }
  assert.equal(decide({ ...ok, status: 404 }).ok, true, '404 is not a challenge');
});

test('fail closed: no status, no navigate data, no probe → detector-error', () => {
  assert.equal(decide({ ...ok, status: null }).evidence.rule, 'status-unreadable');
  assert.equal(decide({ ...ok, nav: null }).evidence.rule, 'navigate-unreadable');
  const p = decide({ ...ok, probe: null });
  assert.equal(p.reason, 'detector-error');
  assert.equal(p.evidence.rule, 'probe-unparseable');
});

test('login wall: redirect to a login path, or to an identity host', () => {
  const a = decide({ ...ok, nav: { finalUrl: 'https://example.com/login?next=/x', title: 'Sign in' } });
  assert.deepEqual([a.reason, a.evidence.rule], ['login-wall', 'login-path']);
  const b = decide({ ...ok, nav: { finalUrl: 'https://accounts.google.com/v3/signin', title: 'x' } });
  assert.deepEqual([b.reason, b.evidence.rule], ['login-wall', 'identity-google']);
  // A login page the queue asked for is not a wall.
  assert.equal(decide({ ...ok, requestedUrl: 'https://example.com/login', nav: { finalUrl: 'https://example.com/login', title: 'x' } }).ok, true);
  // A path that merely contains "login" is not one.
  assert.equal(decide({ ...ok, nav: { finalUrl: 'https://example.com/blog/login-tips', title: 'x' } }).ok, true);
});

test('challenge titles stop as challenge-cf', () => {
  for (const title of ['Just a moment...', 'Attention Required! | Cloudflare', 'Checking your browser before accessing']) {
    assert.equal(decide({ ...ok, nav: { finalUrl: U, title } }).reason, 'challenge-cf', title);
  }
});

test('every probe rule maps to its reason', () => {
  const want = { 'cf-chl-marker': 'challenge-cf', 'hcaptcha-frame': 'hcaptcha', 'recaptcha-frame': 'recaptcha', 'consent-cmp': 'consent-gate', 'age-gate': 'age-gate' };
  const names = loadDetectors().probe.rules.map((r) => r.name);
  assert.deepEqual(names.sort(), Object.keys(want).sort(), 'a rule was added or removed without a test');
  for (const [rule, reason] of Object.entries(want)) {
    const d = decide({ ...ok, probe: { hits: [rule] } });
    assert.deepEqual([d.reason, d.evidence.detector, d.evidence.rule], [reason, 'probe', rule]);
  }
});

test('precedence: status beats final-url beats title beats probe', () => {
  const all = { requestedUrl: U, nav: { finalUrl: 'https://example.com/login', title: 'Just a moment' }, status: 429, probe: { hits: ['hcaptcha-frame'] } };
  assert.equal(decide(all).reason, 'http-429');
  assert.equal(decide({ ...all, status: 200 }).reason, 'login-wall');
  assert.equal(decide({ ...all, status: 200, nav: { finalUrl: U, title: 'Just a moment' } }).reason, 'challenge-cf');
});

test('parseProbe: only a fenced page-lab/probe@1 object counts', () => {
  assert.deepEqual(parseProbe(fenced({ probe: 'page-lab/probe@1', hits: ['age-gate'] })).hits, ['age-gate']);
  assert.equal(parseProbe(JSON.stringify({ message: '{"probe":"page-lab/probe@1","hits":[]}' })), null, 'unfenced');
  assert.equal(parseProbe(fenced({ hits: [] })), null, 'no probe identity');
  assert.equal(parseProbe(fenced({ probe: 'page-lab/probe@1', error: 'bad-selector' })), null, 'probe error');
  assert.equal(parseProbe(fenced({ probe: 'page-lab/probe@1', hits: [{ html: '<x>' }] })), null, 'non-string hit');
  assert.equal(parseProbe('not json'), null);
  assert.equal(parseProbe(''), null);
});

test('parseDocumentStatus: the request at the FINAL URL, its status string read as a number', () => {
  const s = JSON.stringify({
    networkRequests: [
      { url: 'https://a.example/p', status: '403' },
      // A challenge iframe is a document request too, listed after the page.
      { url: 'https://hcaptcha.example/frame', status: 'net::ERR_BLOCKED_BY_CLIENT' },
    ],
  });
  assert.equal(parseDocumentStatus(s, 'https://a.example/p#top'), 403);
  assert.equal(parseDocumentStatus(s, 'https://a.example/other'), null, 'no main request → unreadable');
  assert.equal(parseDocumentStatus(JSON.stringify({ networkRequests: [] }), 'https://a.example/p'), null);
  assert.equal(parseDocumentStatus(JSON.stringify({ networkRequests: [{ url: 'x', status: 'pending' }] }), 'x'), null);
});

test('the probe source is one fixed function carrying every rule name and no reasons', () => {
  const src = probeSource();
  for (const r of loadDetectors().probe.rules) assert.ok(src.includes(JSON.stringify(r.name)));
  assert.equal(src.includes('consent-gate'), false, 'reasons stay in the gate, not the page');
  assert.doesNotThrow(() => new Function(`return (${src})`));
});

test('every rule name is a valid block@1 evidence.rule', () => {
  const d = loadDetectors();
  const names = [
    ...d.status.map((r) => r.name),
    ...d.finalUrl.loginPaths.map((r) => r.name),
    ...d.finalUrl.identityHosts.map((r) => r.name),
    ...d.title.map((r) => r.name),
    ...d.probe.rules.map((r) => r.name),
    'status-unreadable', 'navigate-unreadable', 'navigate-failed', 'probe-unparseable', 'final-url-unparseable',
  ];
  for (const name of names) {
    const ev = buildBlock({ url: U, reason: 'detector-error', evidence: { detector: 'probe', rule: name }, profile: 'lab', runId: 'r', queuePos: 0 });
    assert.deepEqual(validate(ev, loadBlockSchema()).errors, [], name);
  }
});

test('queue: URLs and {url} lines, comments skipped, duplicates dropped, non-http refused', () => {
  const q = parseQueue('# c\nhttps://a.example/1\n{"url":"https://a.example/2"}\n\nhttps://a.example/1\n');
  assert.deepEqual(q.map((i) => i.url), ['https://a.example/1', 'https://a.example/2']);
  assert.match(q[0].item, /^[0-9a-f]{16}$/);
  assert.throws(() => parseQueue('file:///etc/passwd'), /only http/);
  assert.throws(() => parseQueue('nope'), /not a URL/);
});

test('cooldown: 1st block stops the origin, 2nd within 24 h is a cooldown only the human clears', () => {
  const c = {};
  const t0 = Date.parse('2026-11-07T00:00:00Z');
  assert.equal(recordBlock(c, 'https://a.example', t0), 'blocked');
  liftBlocked(c); // a handoff + resume
  assert.equal(c['https://a.example'].state, 'cleared');
  assert.equal(recordBlock(c, 'https://a.example', t0 + 3_600_000), 'cooldown');
  liftBlocked(c);
  assert.equal(c['https://a.example'].state, 'cooldown', 'resume never lifts a cooldown');
  assert.ok(clearCooldown(c, 'https://a.example', t0 + 7_200_000));
  assert.equal(recordBlock(c, 'https://a.example', t0 + 7_300_000), 'blocked', 'the cleared window is forgotten');
  // Outside 24 h, a second block is a first block again.
  const d = {};
  recordBlock(d, 'https://b.example', t0);
  liftBlocked(d);
  assert.equal(recordBlock(d, 'https://b.example', t0 + 25 * 3_600_000), 'blocked');
});

test('cooldown: three origins in cooldown is the abort threshold', () => {
  const c = {};
  for (const o of ['https://a.example', 'https://b.example', 'https://c.example']) {
    recordBlock(c, o, 0);
    recordBlock(c, o, 1);
  }
  assert.equal(cooldownOrigins(c).length, 3);
});

test('nextItem skips done items and held origins, and counts what it held', () => {
  const q = parseQueue('https://a.example/1\nhttps://b.example/1\nhttps://a.example/2\nhttps://c.example/1\n');
  const done = new Set([q[3].item]);
  const c = { 'https://a.example': { blocks: [], state: 'blocked' } };
  const n = nextItem(q, done, c, 0);
  assert.equal(n.next.url, 'https://b.example/1');
  assert.equal(n.next.queuePos, 1);
  const end = nextItem(q, done, c, n.cursor);
  assert.equal(end.next, null);
  assert.deepEqual(end.held, { blocked: 1, cooldown: 0 });
});
