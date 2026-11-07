// page-lab-gate's run state and cooldown exits — no browser, no npx. `run --no-start` writes
// the files, `done` appends, and the drained/cooldown exits are reached before any CLI call.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { itemHash } from '../scripts/lib/gate.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GATE = join(ROOT, 'scripts', 'page-lab-gate.mjs');

function sandbox() {
  const base = mkdtempSync(join(process.env.PAGE_LAB_TEST_TMP || tmpdir(), 'pl-cli-'));
  const env = {
    PATH: process.env.PATH,
    HOME: base,
    XDG_STATE_HOME: join(base, 'state'),
    XDG_CONFIG_HOME: join(base, 'config'),
  };
  const gate = (...args) => {
    const r = spawnSync('node', [GATE, ...args], { env, encoding: 'utf8' });
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: lines.length ? JSON.parse(lines.at(-1)) : null };
  };
  const runDir = (run) => join(env.XDG_STATE_HOME, 'page-lab', 'runs', run);
  const newRun = (run, urls, extra = []) => {
    const q = join(base, `${run}.txt`);
    writeFileSync(q, urls.join('\n'));
    const r = gate('run', '--profile', 'lab', '--run', run, '--queue', q, '--no-start', ...extra);
    assert.equal(r.code, 0, r.stderr);
    return runDir(run);
  };
  return { base, env, gate, runDir, newRun };
}

const URLS = ['https://a.example/1', 'https://a.example/2', 'https://b.example/1', 'https://c.example/1'];

test('run --no-start: queue, cursor, cooldown and meta written, owner-only', () => {
  const { newRun } = sandbox();
  const dir = newRun('r1', [...URLS, URLS[0]]);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const q = readFileSync(join(dir, 'queue.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(q.map((i) => i.url), URLS, 'duplicate dropped');
  assert.equal(statSync(join(dir, 'queue.jsonl')).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'cooldown.json'), 'utf8')), {});
});

test('usage: unknown command, missing --run, bad run id, attach profile, existing run', () => {
  const { gate, newRun, base } = sandbox();
  assert.equal(gate('fly').code, 2);
  assert.equal(gate('nav').code, 2);
  assert.equal(gate('nav', '--run', '../etc').code, 2);
  writeFileSync(join(base, 'q.txt'), URLS[0]);
  assert.equal(gate('run', '--profile', 'daily', '--run', 'x', '--queue', join(base, 'q.txt'), '--no-start').code, 2);
  assert.equal(gate('run', '--profile', 'nope', '--run', 'x', '--queue', join(base, 'q.txt'), '--no-start').code, 2);
  newRun('dup', URLS);
  assert.equal(gate('run', '--profile', 'lab', '--run', 'dup', '--queue', join(base, 'q.txt'), '--no-start').code, 2);
});

test('done: validates against the run schema, appends once, refuses unknown items', () => {
  const { gate, newRun, base } = sandbox();
  const schemaPath = join(base, 'schema.json');
  writeFileSync(schemaPath, JSON.stringify({ type: 'object', required: ['title'], additionalProperties: false, properties: { title: { type: 'string' } } }));
  const dir = newRun('d', URLS, ['--result-schema', schemaPath]);
  const good = join(base, 'good.json');
  const bad = join(base, 'bad.json');
  writeFileSync(good, '{"title":"x"}');
  writeFileSync(bad, '{"html":"<p>"}');
  const item = itemHash(URLS[0]);
  assert.equal(gate('done', '--run', 'd', '--item', 'ffffffffffffffff', '--result', good).code, 2);
  assert.equal(gate('done', '--run', 'd', '--item', item, '--result', bad).code, 1);
  assert.equal(existsSync(join(dir, 'done.jsonl')), false, 'an invalid result leaves the item pending');
  assert.equal(gate('done', '--run', 'd', '--item', item, '--result', good).code, 0);
  assert.equal(gate('done', '--run', 'd', '--item', item, '--result', good).json.already, true);
  assert.equal(readFileSync(join(dir, 'done.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('nav: everything done → drained, exit 0, no browser touched', () => {
  const { gate, newRun, base } = sandbox();
  newRun('n', URLS.slice(0, 2));
  const res = join(base, 'r.json');
  writeFileSync(res, '{}');
  for (const u of URLS.slice(0, 2)) gate('done', '--run', 'n', '--item', itemHash(u), '--result', res);
  const r = gate('nav', '--run', 'n');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([r.json.drained, r.json.done], [true, 2]);
});

test('nav: three origins in cooldown → exit 11 before any CLI call', () => {
  const { gate, newRun } = sandbox();
  const dir = newRun('c', URLS);
  const t = new Date().toISOString();
  const cooling = { blocks: [t, t], state: 'cooldown' };
  writeFileSync(join(dir, 'cooldown.json'), JSON.stringify({ 'https://a.example': cooling, 'https://b.example': cooling, 'https://c.example': cooling }));
  const r = gate('nav', '--run', 'c');
  assert.equal(r.code, 11, r.stderr);
  assert.equal(r.json.cooldown.length, 3);
});

test('nav: every pending item on a cooling origin → exit 11', () => {
  const { gate, newRun } = sandbox();
  const dir = newRun('c1', URLS.slice(0, 2));
  writeFileSync(join(dir, 'cooldown.json'), JSON.stringify({ 'https://a.example': { blocks: [], state: 'cooldown' } }));
  const r = gate('nav', '--run', 'c1');
  assert.equal(r.code, 11);
  assert.deepEqual(r.json.held, { blocked: 0, cooldown: 2 });
});

test('the run protocol never tells the model to open a page itself', () => {
  const text = readFileSync(join(ROOT, 'references', 'gate.md'), 'utf8');
  assert.equal(/navigate_page|new_page/.test(text), false, 'references/gate.md names a navigation tool');
});
