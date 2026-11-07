// page-lab-gate against a REAL browser and the local fixture site: every detector STOPS with
// exit 10 and a schema-valid page-lab/block@1 event, and ordinary pages pass.
//
// Needs a browser: set PAGE_LAB_CHROME to a Chrome for Testing executable (the fleet's
// nixpkgs playwright-driver.browsers-chromium). Without it every case SKIPS, by name — never a
// silent pass.
//
// Everything lives under one throwaway dir (PAGE_LAB_TEST_TMP, else the OS temp dir): XDG
// state, config and the CLI daemon's runtime dir, so the operator's profiles, overlay and any
// concurrent session's daemon are never touched.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadBlockSchema, validate } from '../scripts/lib/envelope.mjs';
import { sessionIdFor } from '../scripts/lib/profiles.mjs';
import { startFixtureServer } from '../scripts/fixtures/gate/server.mjs';

const GATE = fileURLToPath(new URL('../scripts/page-lab-gate.mjs', import.meta.url));
const CHROME = process.env.PAGE_LAB_CHROME;
const skip = CHROME ? false : 'PAGE_LAB_CHROME unset — no browser to drive (live half skipped)';

// Async on purpose: the fixture server runs in THIS process, and a spawnSync would block its
// event loop, so every navigation would hang until the CLI's timeout.
function sh(cmd, args, env) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, encoding: 'utf8', timeout: 180_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

const lastJson = (s) => {
  const lines = s.trim().split('\n').filter(Boolean);
  return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
};

describe('page-lab-gate, live', { skip, concurrency: false }, () => {
  let fx;
  let env;
  let root;
  const gate = async (...args) => {
    const r = await sh('node', [GATE, ...args], env);
    return { ...r, json: lastJson(r.stdout) };
  };
  let runN = 0;
  const newRun = async (paths) => {
    const run = `live-${++runN}`;
    const q = join(root, `${run}.queue`);
    writeFileSync(q, paths.map((p) => `${fx.base}${p}`).join('\n'));
    const r = await gate('run', '--profile', 'lab', '--run', run, '--queue', q);
    assert.equal(r.code, 0, `run: ${r.stdout}\n${r.stderr}`);
    return run;
  };

  before(async () => {
    fx = await startFixtureServer();
    root = mkdtempSync(join(process.env.PAGE_LAB_TEST_TMP || tmpdir(), 'pl-live-'));
    mkdirSync(join(root, 'config', 'page-lab'), { recursive: true });
    mkdirSync(join(root, 'r'), { mode: 0o700 });
    // The allowlist keeps the browser on the fixture origin: the challenge iframes point at
    // third-party hosts, and those loads must never leave the machine.
    writeFileSync(
      join(root, 'config', 'page-lab', 'profiles.json'),
      JSON.stringify([{ schema: 'page-lab/profile@1', name: 'lab', mode: 'dedicated', allowedOrigins: [fx.base] }])
    );
    env = {
      ...process.env,
      HOME: root,
      XDG_STATE_HOME: join(root, 'state'),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_RUNTIME_DIR: join(root, 'r'),
      PAGE_LAB_CHROME: CHROME,
    };
  });

  after(async () => {
    if (env) {
      await sh('npx', ['-y', '-p', 'chrome-devtools-mcp@1.12.0', 'chrome-devtools', 'stop'], {
        ...env,
        CD4A_INTERNAL_DAEMON_SESSION_ID: sessionIdFor('lab'),
        CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
      });
      // A clean stop removes Chromium's Singleton* links (measured); a leftover means a leak.
      assert.equal(existsSync(join(root, 'state', 'page-lab', 'profiles', 'lab', 'SingletonLock')), false);
    }
    await fx?.close();
  });

  const STOPS = [
    ['/403', 'http-403', 'status.403'],
    ['/429', 'http-429', 'status.429'],
    ['/503', 'http-503', 'status.503'],
    ['/redirect-login', 'login-wall', 'login-path'],
    ['/challenge-title', 'challenge-cf', 'title-cf-just-a-moment'],
    ['/cf-chl', 'challenge-cf', 'cf-chl-marker'],
    ['/hcaptcha', 'hcaptcha', 'hcaptcha-frame'],
    ['/recaptcha', 'recaptcha', 'recaptcha-frame'],
    ['/consent', 'consent-gate', 'consent-cmp'],
    ['/age', 'age-gate', 'age-gate'],
  ];

  for (const [path, reason, rule] of STOPS) {
    test(`${path} STOPS: exit 10, ${reason} (${rule}), event valid and recorded`, async () => {
      const run = await newRun([path]);
      const r = await gate('nav', '--run', run);
      assert.equal(r.code, 10, `${r.stdout}\n${r.stderr}`);
      const ev = r.json.event;
      assert.deepEqual(validate(ev, loadBlockSchema()).errors, []);
      assert.equal(ev.reason, reason);
      assert.equal(ev.evidence.rule, rule);
      assert.equal(ev.url, `${fx.base}${path}`);
      const events = readFileSync(join(env.XDG_STATE_HOME, 'page-lab', 'runs', run, 'events.jsonl'), 'utf8').trim().split('\n');
      assert.deepEqual(JSON.parse(events.at(-1)), ev);
    });
  }

  test('ordinary pages pass, done records them, the queue drains with exit 0', async () => {
    const run = await newRun(['/ok', '/ok-2', '/consent-hidden']);
    for (let i = 0; i < 3; i++) {
      const r = await gate('nav', '--run', run);
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal(r.json.ok, true);
      const res = join(root, `${run}-${i}.json`);
      writeFileSync(res, JSON.stringify({ title: 'extracted' }));
      assert.equal((await gate('done', '--run', run, '--item', r.json.item, '--result', res)).code, 0);
    }
    const end = await gate('nav', '--run', run);
    assert.equal(end.code, 0);
    assert.deepEqual([end.json.drained, end.json.pending, end.json.done], [true, 0, 3]);
  });

});
