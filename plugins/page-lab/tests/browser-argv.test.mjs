// browser.sh print-argv — the no-evasion gate (docs/page-lab-vnext-design.md §7.3) and the
// "closed argv" promise, asserted on the real launcher, not on a copy of its flag list.
//
// No browser runs here: print-argv is a dry run. XDG_* point into a throwaway dir so the
// operator's real overlay and state are never read.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
    PAGE_LAB_CHROME: exe,
  };
  if (overlay !== undefined) {
    mkdirSync(join(base, 'config', 'page-lab'), { recursive: true });
    writeFileSync(join(base, 'config', 'page-lab', 'profiles.json'), JSON.stringify(overlay));
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
      assert.equal(r.lines.filter((a) => a.startsWith('--workspace=')).length, 1, 'one workspace root only');
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
  const { env } = sandbox([
    { schema: 'page-lab/profile@1', name: 'lab', mode: 'dedicated', allowedOrigins: ['https://example.com', 'http://127.0.0.1:8080'] },
  ]);
  const r = run(env, 'lab', 'print-argv');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(
    r.lines.filter((a) => a.startsWith('--allowedUrlPattern=')),
    ['--allowedUrlPattern=https://example.com/*', '--allowedUrlPattern=http://127.0.0.1:8080/*']
  );
});

test('overlay: a dedicated userDataDir is refused (the dir is derived, never supplied)', () => {
  const { env } = sandbox([
    { schema: 'page-lab/profile@1', name: 'lab', mode: 'dedicated', userDataDir: '/home/example/.config/chromium' },
  ]);
  const r = run(env, 'lab', 'print-argv');
  assert.equal(r.code, 2);
  assert.match(r.err, /invalid/);
});

test('overlay: not an array, or not JSON, is refused', () => {
  assert.equal(run(sandbox({ profiles: [] }).env, 'lab', 'print-argv').code, 2);
  const { base, env } = sandbox([]);
  writeFileSync(join(base, 'config', 'page-lab', 'profiles.json'), '{');
  assert.equal(run(env, 'lab', 'print-argv').code, 2);
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
