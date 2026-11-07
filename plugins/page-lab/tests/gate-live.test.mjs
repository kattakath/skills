// page-lab-gate against a REAL browser and the local fixture site: every detector STOPS with
// exit 10 and a schema-valid page-lab/block@1 event, ordinary pages pass, and a resume after a
// block re-navigates ZERO done items.
//
// Needs a browser: set PAGE_LAB_CHROME to a Chrome for Testing executable (the fleet's
// nixpkgs playwright-driver.browsers-chromium). Without it every case SKIPS, by name — never a
// silent pass. The headed handoff itself cannot run unattended; tests/gate-cli.test.mjs covers
// it up to the relaunch argv.
//
// The egress preflight runs on every run/resume and the first nav, against the fixture server's
// fake /cdn-cgi/trace (PAGE_LAB_EGRESS_TRACE_URL, honoured only for 127.0.0.1) — never the real
// trace. `lab` has no egress policy (records, never refuses); `lab-egress` allows CA/off.
//
// Everything lives under one throwaway dir (PAGE_LAB_TEST_TMP, else the OS temp dir): XDG
// state, config and the CLI daemon's runtime dir, so the operator's profiles, overlay and any
// concurrent session's daemon are never touched.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadBlockSchema, validate } from '../scripts/lib/envelope.mjs';
import { sessionIdFor } from '../scripts/lib/profiles.mjs';
import { TRACE_IP, startFixtureServer, traceBody } from '../scripts/fixtures/gate/server.mjs';

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
  // Every byte the gate printed, for the ip-leak assertion at the end.
  const transcript = [];
  const gate = async (...args) => {
    const r = await sh('node', [GATE, ...args], env);
    transcript.push(r.stdout, r.stderr);
    return { ...r, json: lastJson(r.stdout) };
  };
  // The cooldown is shared across runs (per origin) and every fixture shares ONE origin, so each
  // case starts from a clean one; the resume case then exercises the window on purpose.
  const cooldownFile = () => join(env.XDG_STATE_HOME, 'page-lab', 'cooldown.json');
  const resetCooldown = () => rmSync(cooldownFile(), { force: true });
  const cooldown = () => (existsSync(cooldownFile()) ? JSON.parse(readFileSync(cooldownFile(), 'utf8')) : {});
  let runN = 0;
  const queueFile = (run, paths) => {
    const q = join(root, `${run}.queue`);
    writeFileSync(q, paths.map((p) => `${fx.base}${p}`).join('\n'));
    return q;
  };
  const newRun = async (paths, profile = 'lab', extra = []) => {
    const run = `live-${++runN}`;
    const r = await gate('run', '--profile', profile, '--run', run, '--queue', queueFile(run, paths), ...extra);
    assert.equal(r.code, 0, `run: ${r.stdout}\n${r.stderr}`);
    return run;
  };
  const runFile = (run, f) => join(env.XDG_STATE_HOME, 'page-lab', 'runs', run, f);
  // Push the last egress check 11 min into the past, so the next nav is due a recheck.
  const ageEgress = (run) => {
    const m = JSON.parse(readFileSync(runFile(run, 'meta.json'), 'utf8'));
    m.egress.at = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    writeFileSync(runFile(run, 'meta.json'), JSON.stringify(m));
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
      JSON.stringify({
        profiles: [
          { name: 'lab', executable: { source: 'env' }, allowedOrigins: [fx.base] },
          {
            name: 'lab-egress',
            mode: 'dedicated',
            headless: true,
            executable: { source: 'env' },
            allowedOrigins: [fx.base],
            egress: { allowLoc: ['CA'], allowWarp: ['off'] },
          },
        ],
      })
    );
    env = {
      ...process.env,
      HOME: root,
      XDG_STATE_HOME: join(root, 'state'),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_CACHE_HOME: join(root, 'cache'),
      XDG_RUNTIME_DIR: join(root, 'r'),
      PAGE_LAB_CHROME: CHROME,
      PAGE_LAB_EGRESS_TRACE_URL: `${fx.base}/cdn-cgi/trace`,
    };
  });

  after(async () => {
    if (env) {
      for (const name of ['lab', 'lab-egress']) {
        await sh('npx', ['-y', '-p', 'chrome-devtools-mcp@1.12.0', 'chrome-devtools', 'stop'], {
          ...env,
          CD4A_INTERNAL_DAEMON_SESSION_ID: sessionIdFor(name),
          CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
        });
        // A clean stop removes Chromium's Singleton* links (measured); a leftover means a leak.
        assert.equal(existsSync(join(root, 'state', 'page-lab', 'profiles', name, 'SingletonLock')), false, name);
      }
    }
    await fx?.close();
  });

  const STOPS = [
    ['/403', 'http-403', 'status.403'],
    ['/429', 'http-429', 'status.429'],
    ['/503', 'http-503', 'status.503'],
    ['/cf-mitigated', 'challenge-cf', 'header-cf-mitigated'],
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
      resetCooldown();
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
      assert.equal(JSON.stringify(ev).includes('not-a-real-secret'), false, 'a cookie reached the event');
      if (path === '/cf-mitigated') assert.deepEqual(Object.keys(ev.evidence.headers).sort(), ['cf-mitigated', 'cf-ray', 'server']);
    });
  }

  test('ordinary pages pass — incl. the cf beacon and a 200-page captcha — no event, no cooldown, drains', async () => {
    resetCooldown();
    const pages = ['/ok', '/ok-2', '/consent-hidden', '/cf-beacon', '/hcaptcha-200'];
    const run = await newRun(pages);
    for (let i = 0; i < pages.length; i++) {
      const r = await gate('nav', '--run', run);
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal(r.json.ok, true);
      const res = join(root, `${run}-${i}.json`);
      writeFileSync(res, JSON.stringify({ title: 'extracted' }));
      assert.equal((await gate('done', '--run', run, '--item', r.json.item, '--result', res)).code, 0);
    }
    const end = await gate('nav', '--run', run);
    assert.equal(end.code, 0);
    assert.deepEqual([end.json.drained, end.json.pending, end.json.done], [true, 0, pages.length]);
    assert.equal(existsSync(join(env.XDG_STATE_HOME, 'page-lab', 'runs', run, 'events.jsonl')), false, 'no event');
    assert.deepEqual(cooldown(), {}, 'no cooldown entry');
  });

  test('resume after a block re-navigates 0 done items; a 2nd block on the origin is a cooldown', async () => {
    resetCooldown();
    const run = await newRun(['/ok', '/403', '/ok-2']);
    const first = await gate('nav', '--run', run);
    assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`);
    const res = join(root, `${run}-r.json`);
    writeFileSync(res, '{}');
    await gate('done', '--run', run, '--item', first.json.item, '--result', res);

    const blocked = await gate('nav', '--run', run);
    assert.equal(blocked.code, 10, `${blocked.stdout}\n${blocked.stderr}`);
    assert.equal(blocked.json.originState, 'blocked');
    // /403 and /ok-2 share the blocked origin: both held, neither navigated, still exit 10.
    const held = await gate('nav', '--run', run);
    assert.equal(held.code, 10, `${held.stdout}\n${held.stderr}`);
    assert.deepEqual(held.json.held, { blocked: 2, cooldown: 0 });

    const plan = await gate('handoff', '--run', run, '--dry-run');
    assert.equal(plan.code, 0, plan.stderr);
    assert.ok(plan.json.argv.includes('--headless=false'));
    assert.equal(plan.json.open, `${fx.base}/403`);

    const resumed = await gate('resume', '--run', run);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(resumed.json.pending, 2);
    assert.equal(resumed.json.items.includes(first.json.item), false);

    // After resume: the 403 is retried once (the human cleared it), blocks again → cooldown.
    const again = await gate('nav', '--run', run);
    assert.equal(again.code, 10, `${again.stdout}\n${again.stderr}`);
    assert.equal(again.json.originState, 'cooldown');
    const cooled = await gate('nav', '--run', run);
    assert.equal(cooled.code, 11, 'every pending item sits on an origin in cooldown');
    const done = readFileSync(join(env.XDG_STATE_HOME, 'page-lab', 'runs', run, 'done.jsonl'), 'utf8').trim().split('\n');
    assert.equal(done.length, 1, 'done.jsonl untouched by resume');
    for (const r of [again, cooled]) assert.notEqual(r.json?.event?.url, first.json.url, 'a done item was re-navigated');
  });
  // -------------------------------------------------------------------------------------------
  // Egress preflight (§7.7)
  // -------------------------------------------------------------------------------------------

  test('egress, no policy: run measures + records, notes it on stderr, never refuses', async () => {
    resetCooldown();
    fx.setTrace(traceBody({ loc: 'AT', colo: 'VIE' }));
    const run = `live-${++runN}`;
    const r = await gate('run', '--profile', 'lab', '--run', run, '--queue', queueFile(run, ['/ok']));
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /loc=AT .*no egress policy, not enforced/);
    assert.deepEqual([r.json.egress.loc, r.json.egress.enforced, r.json.egress.pass], ['AT', false, true]);
    const nav = await gate('nav', '--run', run);
    assert.equal(nav.code, 0, `${nav.stdout}\n${nav.stderr}`);
    fx.setTrace(traceBody());
  });

  test('egress match: run passes, nav proceeds without a recheck inside 10 min', async () => {
    resetCooldown();
    fx.setTrace(traceBody());
    const before = fx.hits('/cdn-cgi/trace');
    const run = await newRun(['/ok'], 'lab-egress');
    const st = await gate('status', '--run', run);
    assert.deepEqual([st.json.egress.loc, st.json.egress.warp, st.json.egress.pass, st.json.egress.enforced], ['CA', 'off', true, true]);
    const nav = await gate('nav', '--run', run);
    assert.equal(nav.code, 0, `${nav.stdout}\n${nav.stderr}`);
    assert.equal(fx.hits('/cdn-cgi/trace') - before, 1, 'one measurement: the run start; nav reused it');
  });

  test('egress mismatch at the 10-min recheck: exit 13, egress-mismatch event, 0 items navigated, no cooldown', async () => {
    resetCooldown();
    fx.setTrace(traceBody());
    const run = await newRun(['/ok-3'], 'lab-egress');
    // The VPN moves after the run started; the nav's recheck must see it.
    ageEgress(run);
    fx.setTrace(traceBody({ loc: 'AT', colo: 'VIE' }));
    const okBefore = fx.hits('/ok-3');
    const r = await gate('nav', '--run', run);
    assert.equal(r.code, 13, `${r.stdout}\n${r.stderr}`);
    const ev = r.json.event;
    assert.deepEqual(validate(ev, loadBlockSchema()).errors, []);
    assert.deepEqual([ev.reason, ev.evidence.detector, ev.evidence.rule, ev.evidence.loc, ev.evidence.colo, ev.evidence.warp], [
      'egress-mismatch', 'egress', 'egress.loc', 'AT', 'VIE', 'off',
    ]);
    assert.equal(ev.queuePos, 0);
    assert.deepEqual(JSON.parse(readFileSync(runFile(run, 'events.jsonl'), 'utf8').trim().split('\n').at(-1)), ev);
    assert.equal(fx.hits('/ok-3'), okBefore, 'a queue item was navigated');
    assert.deepEqual(JSON.parse(readFileSync(runFile(run, 'cursor.json'), 'utf8')), { cursor: 0 }, 'the cursor moved');
    assert.equal(existsSync(runFile(run, 'done.jsonl')), false);
    assert.deepEqual(cooldown(), {}, 'an egress refusal is not a site block');
    // A refusal is never remembered as a pass: the next nav measures again and refuses again.
    const again = await gate('nav', '--run', run);
    assert.equal(again.code, 13);
    assert.equal(fx.hits('/ok-3'), okBefore);
    // Fixed egress + resume (same step) → the run continues.
    fx.setTrace(traceBody());
    const resumed = await gate('resume', '--run', run);
    assert.equal(resumed.code, 0, `${resumed.stdout}\n${resumed.stderr}`);
    assert.equal(resumed.json.egress.pass, true);
    const nav = await gate('nav', '--run', run);
    assert.equal(nav.code, 0, `${nav.stdout}\n${nav.stderr}`);
    assert.equal(fx.hits('/ok-3'), okBefore + 1);
  });

  test('egress mismatch at run start: exit 13 before any nav', async () => {
    resetCooldown();
    fx.setTrace(traceBody({ warp: 'on' }));
    const run = `live-${++runN}`;
    const r = await gate('run', '--profile', 'lab-egress', '--run', run, '--queue', queueFile(run, ['/ok-3']));
    assert.equal(r.code, 13, `${r.stdout}\n${r.stderr}`);
    assert.equal(r.json.event.evidence.rule, 'egress.warp');
    fx.setTrace(traceBody());
  });

  test('egress trace garbage with a policy: exit 10 detector-error, fail closed, no cooldown', async () => {
    resetCooldown();
    fx.setTrace(traceBody());
    const run = await newRun(['/ok-3'], 'lab-egress');
    ageEgress(run);
    fx.setTrace('<html><body>nope</body></html>');
    const okBefore = fx.hits('/ok-3');
    const r = await gate('nav', '--run', run);
    assert.equal(r.code, 10, `${r.stdout}\n${r.stderr}`);
    assert.deepEqual([r.json.event.reason, r.json.event.evidence.detector, r.json.event.evidence.rule], [
      'detector-error', 'egress', 'egress-trace-unreadable',
    ]);
    assert.deepEqual(validate(r.json.event, loadBlockSchema()).errors, []);
    assert.equal(fx.hits('/ok-3'), okBefore);
    assert.deepEqual(cooldown(), {});
    fx.setTrace(traceBody());
  });

  test('egress: the trace ip never reaches stdout, stderr, events, meta or status', async () => {
    const st = await gate('status', '--run', `live-${runN}`);
    assert.equal(st.code, 0);
    assert.ok(transcript.length > 0);
    assert.equal(transcript.join('\n').includes(TRACE_IP), false, 'ip in the gate output');
    const runs = join(env.XDG_STATE_HOME, 'page-lab', 'runs');
    let files = 0;
    for (const run of readdirSync(runs)) {
      for (const f of readdirSync(join(runs, run))) {
        files++;
        assert.equal(readFileSync(join(runs, run, f), 'utf8').includes(TRACE_IP), false, `ip in ${run}/${f}`);
      }
    }
    assert.ok(files > 0, 'no run files scanned');
    assert.ok(fx.hits('/cdn-cgi/trace') > 0, 'the fixture trace was never read — the cases measured nothing');
  });
});
