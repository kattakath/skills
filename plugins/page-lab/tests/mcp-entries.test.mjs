// .mcp.json — the three entries and what each launches.
//
//   chrome-devtools  attach, the UNCHANGED launcher (asserted in browser-argv.test.mjs too)
//   chrome-lab       dedicated, on lab-diag, through browser.sh's closed argv
//   kapture          gated: nothing starts unless PAGE_LAB_KAPTURE=1

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveProfile } from '../scripts/lib/profiles.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MCP = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8')).mcpServers;

test('exactly three servers', () => {
  assert.deepEqual(Object.keys(MCP).sort(), ['chrome-devtools', 'chrome-lab', 'kapture']);
});

test('chrome-lab is browser.sh lab-diag mcp, and lab-diag is a dedicated profile', () => {
  assert.equal(MCP['chrome-lab'].command, '${CLAUDE_PLUGIN_ROOT}/scripts/browser.sh');
  assert.deepEqual(MCP['chrome-lab'].args, ['lab-diag', 'mcp']);
  assert.equal(resolveProfile('lab-diag', { HOME: '/nonexistent' }).mode, 'dedicated');
});

// A fake npx on PATH records whether the launcher tried to start anything.
function withFakeNpx() {
  const dir = mkdtempSync(join(process.env.PAGE_LAB_TEST_TMP || tmpdir(), 'pl-npx-'));
  const marker = join(dir, 'ran');
  writeFileSync(join(dir, 'npx'), `#!/bin/sh\nprintf '%s\\n' "$*" > '${marker}'\n`);
  chmodSync(join(dir, 'npx'), 0o755);
  return { path: `${dir}:${process.env.PATH}`, marker };
}

test('kapture: disabled by default — exit 0, one clear stderr line, nothing started', () => {
  assert.equal(MCP.kapture.command, '${CLAUDE_PLUGIN_ROOT}/scripts/kapture-bridge.sh');
  const { path, marker } = withFakeNpx();
  const r = spawnSync('sh', [join(ROOT, 'scripts', 'kapture-bridge.sh')], { env: { PATH: path }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, 'kapture disabled: set PAGE_LAB_KAPTURE=1 for supervised pick tiers 2/3\n');
  assert.equal(r.stdout, '', 'stdout is the MCP channel; it stays empty');
  assert.equal(existsSync(marker), false);
});

test('kapture: PAGE_LAB_KAPTURE=1 execs the pinned bridge', () => {
  const { path, marker } = withFakeNpx();
  const r = spawnSync('sh', [join(ROOT, 'scripts', 'kapture-bridge.sh')], { env: { PATH: path, PAGE_LAB_KAPTURE: '1' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(marker, 'utf8').trim(), '-y kapture-mcp@2.6.1 bridge');
});
