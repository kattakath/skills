// browser.sh print-argv — the no-evasion gate (docs/page-lab-vnext-design.md §7.3) and the
// "closed argv" promise, asserted on the real launcher, not on a copy of its flag list.
//
// No browser runs here: print-argv is a dry run. XDG_* point into a throwaway dir so the
// operator's real overlay and state are never read.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadProfileSchema, validate } from '../scripts/lib/envelope.mjs';
import { DEFAULT_PROFILES } from '../scripts/lib/profiles.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BROWSER = join(ROOT, 'scripts', 'browser.sh');

const FORBIDDEN = /proxy|AutomationControlled|user-agent|ignoreDefaultChromeArg|acceptInsecureCerts|stealth|chromeArg/i;
const REQUIRED = [
  '--categoryEmulation=false',
  '--categoryExtensions=false',
  '--redactNetworkHeaders',
  '--no-usage-statistics',
  '--no-performance-crux',
  '--fileNavigations=false',
];

function sandbox(overlay) {
  const base = mkdtempSync(join(process.env.PAGE_LAB_TEST_TMP || tmpdir(), 'pl-argv-'));
  const exe = join(base, 'fake chrome'); // a space, on purpose: .app bundle paths have them
  writeFileSync(exe, '#!/bin/sh\nexit 0\n');
  chmodSync(exe, 0o755);
  const env = {
    PATH: process.env.PATH,
    HOME: base,
    XDG_STATE_HOME: join(base, 'state'),
    XDG_CONFIG_HOME: join(base, 'config'),
    XDG_CACHE_HOME: join(base, 'cache'),
    PAGE_LAB_CHROME: exe,
  };
  if (overlay !== undefined) {
    mkdirSync(join(base, 'config', 'page-lab'), { recursive: true });
    writeFileSync(join(base, 'config', 'page-lab', 'profiles.json'), typeof overlay === 'string' ? overlay : JSON.stringify(overlay));
  }
  return { base, env, exe };
}

function run(env, ...args) {
  const r = spawnSync('sh', [BROWSER, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, lines: r.stdout.split('\n').filter(Boolean) };
}

test('default profiles are valid profile@1 records', () => {
  for (const p of DEFAULT_PROFILES) assert.deepEqual(validate(p, loadProfileSchema()).errors, [], p.name);
  assert.deepEqual(DEFAULT_PROFILES.map((p) => p.name), ['daily', 'lab', 'lab-diag']);
});

for (const name of ['lab', 'lab-diag']) {
  test(`${name}: print-argv carries no evasion flag and every required one`, () => {
    const { env, exe } = sandbox();
    for (const variant of [[], ['headed']]) {
      const r = run(env, name, 'print-argv', ...variant);
      assert.equal(r.code, 0, r.err);
      for (const a of r.lines) assert.doesNotMatch(a, FORBIDDEN, `forbidden flag: ${a}`);
      for (const req of REQUIRED) assert.ok(r.lines.includes(req), `missing ${req}`);
      assert.ok(r.lines.includes(`--executablePath=${exe}`), 'PAGE_LAB_CHROME kept whole despite the space');
      assert.ok(r.lines.includes(`--userDataDir=${join(env.XDG_STATE_HOME, 'page-lab', 'profiles', name)}`));
      assert.deepEqual(r.lines.filter((a) => a.startsWith('--workspace=')), [
        `--workspace=${join(env.XDG_CACHE_HOME, 'page-lab', 'workspace', name)}`,
      ], 'one workspace root, under the CACHE home (the state tree is denied to the agent)');
    }
  });
}

test('headed differs from headless by exactly --headless=true -> --headless=false', () => {
  const { env } = sandbox();
  const a = run(env, 'lab', 'print-argv').lines;
  const b = run(env, 'lab', 'print-argv', 'headed').lines;
  assert.equal(a.length, b.length);
  const diff = a.map((x, i) => [x, b[i]]).filter(([x, y]) => x !== y);
  // Upstream defaults --headless to TRUE, so "minus --headless" would still be headless.
  assert.deepEqual(diff, [['--headless=true', '--headless=false']]);
});

test('closed argv: extra arguments are refused, never forwarded', () => {
  const { env } = sandbox();
  for (const extra of [['--proxyServer=http://x'], ['--chromeArg=--user-agent=x'], ['headed', 'x']]) {
    const r = run(env, 'lab', 'print-argv', ...extra);
    assert.equal(r.code, 2, `accepted ${extra.join(' ')}`);
    assert.equal(r.out, '');
  }
  assert.equal(run(env, 'lab', 'up', '--headless=false').code, 2);
});

test('overlay: allowedOrigins become URL-pattern allowlist entries', () => {
  const { env } = sandbox({ profiles: [{ name: 'lab', allowedOrigins: ['https://example.com', 'http://127.0.0.1:8080'] }] });
  const r = run(env, 'lab', 'print-argv');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(
    r.lines.filter((a) => a.startsWith('--allowedUrlPattern=')),
    ['--allowedUrlPattern=https://example.com/*', '--allowedUrlPattern=http://127.0.0.1:8080/*']
  );
});

test('overlay: a dedicated userDataDir is refused (the dir is derived, never supplied)', () => {
  const { env } = sandbox({ profiles: [{ name: 'lab', userDataDir: '/home/example/.config/chromium' }] });
  const r = run(env, 'lab', 'print-argv');
  assert.equal(r.code, 2);
  assert.match(r.err, /invalid/);
});

test('overlay: the bare-array form, extra top-level keys, nameless/unknown/modeless entries are refused', () => {
  for (const bad of [
    [{ schema: 'page-lab/profile@1', name: 'lab', mode: 'dedicated' }],
    { profiles: [], version: 1 },
    { profiles: {} },
    { profiles: [{ executable: { source: 'env' } }] },
    { profiles: [{ name: 'lab', stealth: true }] },
    { profiles: [{ name: 'brand-new' }] },
  ]) {
    const r = run(sandbox(bad).env, 'lab', 'print-argv');
    assert.equal(r.code, 2, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(run(sandbox('{').env, 'lab', 'print-argv').code, 2, 'not JSON');
});

test('overlay: the fleet Home Manager file, verbatim — merged by name, PAGE_LAB_CHROME with spaces kept whole', () => {
  const { base, env, exe } = sandbox();
  mkdirSync(join(base, 'config', 'page-lab'), { recursive: true });
  copyFileSync(join(ROOT, 'scripts', 'fixtures', 'overlay', 'fleet-hm.json'), join(base, 'config', 'page-lab', 'profiles.json'));
  for (const name of ['lab', 'lab-diag']) {
    const r = run(env, name, 'print-argv');
    assert.equal(r.code, 0, r.err);
    assert.ok(r.lines.includes(`--executablePath=${exe}`));
    assert.ok(r.lines.includes('--headless=true'), 'defaults survive the partial entry');
  }
  assert.equal(run(env, 'daily', 'print-argv').code, 0, 'daily is untouched');
  // source "env" means THE pinned browser: unset is an error, never a silent fallback.
  const unset = { ...env };
  delete unset.PAGE_LAB_CHROME;
  const r = run(unset, 'lab', 'print-argv');
  assert.equal(r.code, 2);
  assert.match(r.err, /PAGE_LAB_CHROME/);
});

test('dedicated never attaches: no debugging port, no browserUrl/wsEndpoint/autoConnect — in argv or in source', () => {
  const { env } = sandbox();
  const NOPE = /remote-debugging-port|browserUrl|browser-url|wsEndpoint|autoConnect/i;
  for (const name of ['lab', 'lab-diag']) {
    for (const v of [[], ['headed']]) {
      for (const a of run(env, name, 'print-argv', ...v).lines) assert.doesNotMatch(a, NOPE, a);
    }
  }
  for (const f of ['scripts/page-lab-gate.mjs', 'scripts/lib/gate.mjs', 'scripts/lib/profiles.mjs']) {
    const code = readFileSync(join(ROOT, f), 'utf8');
    assert.doesNotMatch(code, NOPE, `${f} names an attach transport`);
  }
});

test('mcp: a LIVE lab-diag lock at spawn fails closed — one chrome-lab per machine', () => {
  const { env } = sandbox();
  const pdir = join(env.XDG_STATE_HOME, 'page-lab', 'profiles', 'lab-diag');
  mkdirSync(pdir, { recursive: true });
  symlinkSync(`${hostname()}-${process.pid}`, join(pdir, 'SingletonLock'));
  const r = run(env, 'lab-diag', 'mcp');
  assert.equal(r.code, 12);
  assert.equal(r.err, `browser.sh: lab-diag in use by pid ${process.pid}; one chrome-lab per machine\n`);
  assert.equal(r.out, '', 'stdout is the MCP channel');
});

test('no executable configured: upstream resolution, announced on stderr', () => {
  const { env } = sandbox();
  delete env.PAGE_LAB_CHROME;
  const r = run(env, 'lab', 'print-argv');
  assert.equal(r.code, 0);
  assert.equal(r.lines.some((a) => a.startsWith('--executablePath')), false);
  assert.match(r.err, /resolves its own Chrome/);
});

test('attach: daily is never launched, stopped or relaunched by page-lab', () => {
  const { env } = sandbox();
  assert.equal(run(env, 'daily', 'headed').code, 2);
  assert.equal(run(env, 'daily', 'down').code, 2);
  const r = run(env, 'daily', 'print-argv');
  assert.equal(r.code, 0);
  assert.match(r.out, /chrome-devtools-attach\.sh/);
});

test('.mcp.json chrome-devtools still names the unchanged attach launcher', () => {
  const mcp = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers['chrome-devtools'].command, '${CLAUDE_PLUGIN_ROOT}/scripts/chrome-devtools-attach.sh');
  assert.equal(mcp.mcpServers['chrome-devtools'].args, undefined);
});
