// The egress preflight's PURE half (§7.7), without a browser: the trace filter keeps six fields
// and drops ip, the policy refuses a mismatch and fails closed on an unreadable trace, the
// recheck window, the 127.0.0.1-only trace override, and the allowlist the gate launches with.
// tests/gate-live.test.mjs runs the preflight itself through a real browser and the fixture
// server's fake /cdn-cgi/trace.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildBlock, loadBlockSchema, validate } from '../scripts/lib/envelope.mjs';
import {
  EGRESS_FIELDS,
  EGRESS_RECHECK_MS,
  EGRESS_TRACE_URL,
  decideEgress,
  egressDue,
  egressSource,
  filterTrace,
  parseEgress,
  traceUrl,
} from '../scripts/lib/gate.mjs';
import { dedicatedArgv, resolveProfile } from '../scripts/lib/profiles.mjs';
import { TRACE_IP, traceBody } from '../scripts/fixtures/gate/server.mjs';

const GATE = fileURLToPath(new URL('../scripts/page-lab-gate.mjs', import.meta.url));
const fenced = (v) => JSON.stringify({ message: `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\`` });
const CA = { loc: 'CA', colo: 'YYZ', warp: 'off', gateway: 'off', http: 'http/2', tls: 'TLSv1.3' };
const POLICY = { allowLoc: ['CA'], allowWarp: ['off'] };

test('filterTrace keeps exactly the six fields and never ip', () => {
  const f = filterTrace(traceBody());
  assert.deepEqual(Object.keys(f).sort(), [...EGRESS_FIELDS].sort());
  assert.deepEqual(f, CA);
  assert.equal(JSON.stringify(f).includes(TRACE_IP), false);
});

test('egressSource runs in a page and returns only the allowed fields', () => {
  // The page side, with a stand-in document: the same string evaluate_script receives.
  const run = new Function('document', `return (${egressSource()})();`);
  const v = run({ body: { innerText: traceBody({ loc: 'AT', colo: 'VIE' }) } });
  assert.equal(v.egress, 'page-lab/egress@1');
  assert.deepEqual(v.fields, { ...CA, loc: 'AT', colo: 'VIE' });
  assert.equal(JSON.stringify(v).includes(TRACE_IP), false, 'ip left the page');
  assert.deepEqual(parseEgress(fenced(v)), { ...CA, loc: 'AT', colo: 'VIE' });
});

test('parseEgress: anything but the fenced marker + a two-letter loc + known keys is null', () => {
  const good = { egress: 'page-lab/egress@1', fields: CA };
  assert.deepEqual(parseEgress(fenced(good)), CA);
  for (const bad of [
    'not json',
    JSON.stringify({ message: 'no fence' }),
    fenced({ egress: 'other', fields: CA }),
    fenced({ egress: 'page-lab/egress@1', fields: { ...CA, ip: TRACE_IP } }),
    fenced({ egress: 'page-lab/egress@1', fields: { colo: 'YYZ' } }),
    fenced({ egress: 'page-lab/egress@1', fields: { ...CA, loc: 'Canada' } }),
    fenced({ egress: 'page-lab/egress@1', fields: { ...CA, colo: 'a b' } }),
    fenced({ egress: 'page-lab/egress@1', fields: [] }),
  ]) {
    assert.equal(parseEgress(bad), null, bad);
  }
});

test('decideEgress: match passes, loc or warp mismatch refuses with loc/colo/warp only', () => {
  assert.deepEqual(decideEgress(CA, POLICY), { ok: true, enforced: true });
  const loc = decideEgress({ ...CA, loc: 'AT', colo: 'VIE' }, POLICY);
  assert.deepEqual(loc, { ok: false, reason: 'egress-mismatch', rule: 'egress.loc', evidence: { loc: 'AT', colo: 'VIE', warp: 'off' } });
  assert.equal(decideEgress({ ...CA, warp: 'on' }, POLICY).rule, 'egress.warp');
  assert.equal(decideEgress({ ...CA, warp: undefined }, POLICY).rule, 'egress.warp', 'a missing warp is not a pass');
  assert.deepEqual(decideEgress({ ...CA, warp: 'on' }, { allowLoc: ['CA'] }), { ok: true, enforced: true });
});

test('decideEgress: a mismatch whose colo/warp the schema cannot carry still yields a VALID event', () => {
  const d = decideEgress({ ...CA, loc: 'T1', colo: 'weird-colo', warp: 'maybe' }, POLICY);
  assert.deepEqual([d.reason, d.rule, d.evidence], ['egress-mismatch', 'egress.loc', { loc: 'T1' }]);
  const ev = buildBlock({ url: EGRESS_TRACE_URL, reason: d.reason, evidence: { detector: 'egress', rule: d.rule, ...d.evidence }, profile: 'lab', runId: 'r1', queuePos: 0 });
  assert.deepEqual(validate(ev, loadBlockSchema()).errors, [], 'exit 13 would become exit 1 with no event');
  assert.deepEqual(parseEgress(fenced({ egress: 'page-lab/egress@1', fields: { loc: 'XX' } })), { loc: 'XX' }, 'unknown country parses');
});

test('decideEgress: unreadable trace fails CLOSED with a policy, never refuses without one', () => {
  assert.deepEqual(decideEgress(null, POLICY), { ok: false, reason: 'detector-error', rule: 'egress-trace-unreadable', evidence: {} });
  assert.deepEqual(decideEgress(null, undefined), { ok: true, enforced: false });
  assert.deepEqual(decideEgress({ ...CA, loc: 'AT' }, undefined), { ok: true, enforced: false });
  assert.deepEqual(decideEgress({ ...CA, loc: 'AT' }, { allowLoc: [] }), { ok: true, enforced: false });
});

test('egress events validate as block@1 and carry no ip', () => {
  const d = decideEgress({ ...CA, loc: 'AT', colo: 'VIE' }, POLICY);
  const ev = buildBlock({
    url: EGRESS_TRACE_URL,
    reason: d.reason,
    evidence: { detector: 'egress', rule: d.rule, ...d.evidence },
    profile: 'lab',
    runId: 'r1',
    queuePos: 0,
  });
  assert.deepEqual(validate(ev, loadBlockSchema()).errors, []);
  const err = decideEgress(null, POLICY);
  const ev2 = buildBlock({ ...ev, reason: err.reason, evidence: { detector: 'egress', rule: err.rule } });
  assert.deepEqual(validate(ev2, loadBlockSchema()).errors, []);
  assert.equal(validate({ ...ev, evidence: { ...ev.evidence, ip: TRACE_IP } }, loadBlockSchema()).valid, false);
});

test('egressDue: first check, 10-min window, a failed check, a policy change', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const at = (ms) => new Date(now - ms).toISOString();
  assert.equal(egressDue(undefined, now, true), true);
  assert.equal(egressDue({ at: 'garbage', pass: true, enforced: true }, now, true), true);
  assert.equal(egressDue({ at: at(EGRESS_RECHECK_MS - 1000), pass: true, enforced: true }, now, true), false);
  assert.equal(egressDue({ at: at(EGRESS_RECHECK_MS), pass: true, enforced: true }, now, true), true);
  assert.equal(egressDue({ at: at(1000), pass: false, enforced: true }, now, true), true, 'a refusal is never remembered as a pass');
  assert.equal(egressDue({ at: at(1000), pass: true, enforced: false }, now, true), true, 'policy added mid-run');
});

test('traceUrl: the override is honoured ONLY for http://127.0.0.1', () => {
  assert.deepEqual(traceUrl({}), { url: EGRESS_TRACE_URL, overridden: false, ignored: false });
  assert.equal(traceUrl({ PAGE_LAB_EGRESS_TRACE_URL: 'http://127.0.0.1:4321/cdn-cgi/trace' }).url, 'http://127.0.0.1:4321/cdn-cgi/trace');
  for (const u of [
    'https://evil.example/cdn-cgi/trace',
    'http://localhost:4321/cdn-cgi/trace',
    'http://127.0.0.1.evil.example/x',
    'http://[::1]:4321/x',
    'https://127.0.0.1/x',
    'not a url',
  ]) {
    const t = traceUrl({ PAGE_LAB_EGRESS_TRACE_URL: u });
    assert.deepEqual([t.url, t.ignored], [EGRESS_TRACE_URL, true], u);
  }
});

test('extraOrigins widens an allowlist and never creates one', () => {
  const env = { HOME: '/nonexistent', XDG_STATE_HOME: '/nonexistent/s' };
  const open = dedicatedArgv(resolveProfile('lab', env), { headless: true, workspace: '/w', extraOrigins: ['https://www.cloudflare.com'], env }).argv;
  assert.equal(open.some((a) => a.startsWith('--allowedUrlPattern')), false, 'an open profile became trace-only');
  const p = { schema: 'page-lab/profile@1', name: 'lab', mode: 'dedicated', allowedOrigins: ['https://a.example', 'https://www.cloudflare.com'] };
  const pats = dedicatedArgv(p, { workspace: '/w', extraOrigins: ['https://www.cloudflare.com', 'http://127.0.0.1:9'], env }).argv.filter((a) =>
    a.startsWith('--allowedUrlPattern')
  );
  assert.deepEqual(pats, ['--allowedUrlPattern=https://a.example/*', '--allowedUrlPattern=https://www.cloudflare.com/*', '--allowedUrlPattern=http://127.0.0.1:9/*']);
});

test('gate: handoff argv on an allowlisted profile carries the trace origin and differs by --headless only', () => {
  const base = mkdtempSync(join(process.env.PAGE_LAB_TEST_TMP || tmpdir(), 'pl-egress-'));
  const env = { PATH: process.env.PATH, HOME: base, XDG_STATE_HOME: join(base, 'state'), XDG_CONFIG_HOME: join(base, 'config') };
  mkdirSync(join(base, 'config', 'page-lab'), { recursive: true });
  writeFileSync(
    join(base, 'config', 'page-lab', 'profiles.json'),
    JSON.stringify({ profiles: [{ name: 'lab', allowedOrigins: ['https://a.example'], egress: POLICY }] })
  );
  writeFileSync(join(base, 'q.txt'), 'https://a.example/1\n');
  const gate = (...args) => spawnSync('node', [GATE, ...args], { env, encoding: 'utf8' });
  assert.equal(gate('run', '--profile', 'lab', '--run', 'e', '--queue', join(base, 'q.txt'), '--no-start').status, 0);
  const h = gate('handoff', '--run', 'e', '--dry-run', '--offline');
  const r = gate('resume', '--run', 'e', '--dry-run', '--offline');
  assert.equal(h.status, 0, h.stderr);
  const ha = JSON.parse(h.stdout.trim()).argv;
  const ra = JSON.parse(r.stdout.trim()).argv;
  assert.ok(ha.includes('--allowedUrlPattern=https://www.cloudflare.com/*'), 'the preflight would be refused by the run allowlist');
  assert.deepEqual(
    ha.map((a, i) => [ra[i], a]).filter(([x, y]) => x !== y),
    [['--headless=true', '--headless=false']]
  );
  const st = gate('status', '--run', 'e');
  assert.equal(JSON.parse(st.stdout.trim()).egress, null, '--no-start defers the measurement to the first nav');
});
