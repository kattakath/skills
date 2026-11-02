#!/usr/bin/env node
// Does supervised driving WORK? — trusted-input proof, both halves, on a local fixture.
//
//   node supervise-selftest.mjs --browser-url http://127.0.0.1:9333
//
// Run it against a THROWAWAY Chromium (own --user-data-dir and port), never the operator's
// browser: it opens its own background tabs, starts and stops the supervise daemon, and the
// last section ACTIVATES a tab for real (Target.activateTarget), which brings that Chromium's
// window forward on the machine running the test.
// Operator and agent input are indistinguishable at the CDP layer [F-SUPERVISE-TRUSTED-SAME],
// so "operator input" below is a trusted event sent WITHOUT arming a window, and "agent
// input" is the same event sent INSIDE one. Exit 0 = every check held; 1 = a check failed.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { attach, browserSocket, connect } from './lib/cdp.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const argv = process.argv.slice(2);
const browserUrl = argv[argv.indexOf('--browser-url') + 1] || 'http://127.0.0.1:9333';
const SUP = fileURLToPath(new URL('./supervise.mjs', import.meta.url));
const RUN = Math.random().toString(36).slice(2, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}\n`);
};

// cdp.mjs re-execs once and marks the child with PAGE_LAB_CDP_WS_REEXEC=1; a child that INHERITS it
// refuses to re-exec itself and exits 7. Strip it from anything spawned from here.
const { PAGE_LAB_CDP_WS_REEXEC: _drop, ...CLEAN_ENV } = process.env;
const sup = (args, env = {}) =>
  spawnSync(process.execPath, [SUP, ...args, ...(args[0] === 'start' ? ['--browser-url', browserUrl] : [])], {
    encoding: 'utf8',
    env: { ...CLEAN_ENV, PAGE_LAB_SUPERVISE_NO_OSASCRIPT: '1', ...env },
  });

// -- fixture server ----------------------------------------------------------------------
const server = createServer((req, res) => {
  const name = req.url.split('?')[0] === '/second.html' ? 'second.html' : 'index.html';
  res.setHeader('content-type', 'text/html');
  res.end(readFileSync(`${HERE}fixtures/supervise/${name}`));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const client = await connect(await browserSocket(browserUrl));
let targetId;
try {
  const cr = await client.send('Target.createTarget', { url: 'about:blank', background: true });
  targetId = cr.targetId;
  const sid = await attach(client, targetId);
  await client.send('Page.enable', {}, sid);
  await client.send('Runtime.enable', {}, sid);
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sid); // [F-FOCUS-EMULATION]

  const ev = async (expression) => {
    const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value;
  };
  const pl = (x) => ev(`JSON.stringify(window.__pageLab && ${x})`).then((v) => (v ? JSON.parse(v) : null));
  const click = async (x, y) => {
    const b = { x, y, button: 'left', clickCount: 1 };
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...b, buttons: 0 }, sid);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...b, buttons: 1 }, sid);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...b, buttons: 0 }, sid);
  };
  const center = (sel) =>
    ev(`(()=>{const b=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`);
  const clickSel = async (sel) => {
    const c = await center(sel);
    await click(c.x, c.y);
  };
  const key = (k, code, vk) =>
    client
      .send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk }, sid)
      .then(() => client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }, sid));
  const typeText = (t) => client.send('Input.insertText', { text: t }, sid);
  const waitFor = async (fn, ms = 4000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(80)) if (await fn().catch(() => false)) return true;
    return false;
  };
  const navigate = async (url) => {
    await client.send('Page.navigate', { url }, sid);
    await waitFor(async () => (await ev('location.href')) === url && (await pl('1')) === 1);
  };
  const inState = (s) => waitFor(async () => (await pl('window.__pageLab.state')) === s);

  // -- boot ---------------------------------------------------------------------------
  const started = sup(['start']);
  check('daemon starts', started.status === 0, started.stdout.trim());
  await navigate(`${base}/index.html`);
  check('overlay present and armed after document-start injection', await inState('agent'));

  // -- half 1: with the layer armed and NO window, operator input must not land -----------
  await ev(`document.getElementById('txt').focus()`);
  await clickSel('#btn');
  await key('a', 'KeyA', 65);
  await typeText('z');
  const blocked = await ev(`({n:document.getElementById('n').textContent,v:document.getElementById('txt').value})`);
  check('BLOCK: trusted click does not land with no window', blocked.n === '0', `clicks=${blocked.n}`);
  check('BLOCK: trusted key + insertText do not land with no window', blocked.v === '', `value="${blocked.v}"`);
  const st1 = await pl('window.__pageLab.stats');
  check('BLOCK: swallowed events are counted', st1.blockedPointer > 0 && st1.blockedKey > 0, JSON.stringify(st1));

  // -- half 2: inside an armed window the same input lands --------------------------------
  const p = await pl('window.__pageLab.pass(3000)');
  check('PASS: pass() returns ok while agent state', p?.ok === true);
  await clickSel('#btn');
  await ev(`document.getElementById('txt').focus()`);
  await key('a', 'KeyA', 65);
  await typeText('b');
  const passed = await ev(`({n:document.getElementById('n').textContent,v:document.getElementById('txt').value})`);
  check('PASS: trusted click lands inside the window', passed.n === '1', `clicks=${passed.n}`);
  check('PASS: trusted key + insertText land inside the window', passed.v.endsWith('b'), `value="${passed.v}"`);

  // -- the window shuts itself --------------------------------------------------------------
  await pl('window.__pageLab.pass(300)');
  await sleep(600);
  await clickSel('#btn');
  check('window closes by itself', (await ev(`document.getElementById('n').textContent`)) === '1');
  await pl('window.__pageLab.pass(5000,{once:true})');
  await clickSel('#btn'); // lands, and the once-window shuts on the click
  await clickSel('#btn'); // must be swallowed
  check('once:true shuts the window on the first click', (await ev(`document.getElementById('n').textContent`)) === '2');

  // -- survives a real navigation ----------------------------------------------------------
  await pl('window.__pageLab.pass(5000)');
  await clickSel('#next');
  await waitFor(async () => (await ev('location.pathname')) === '/second.html' && (await pl('1')) === 1);
  check('overlay re-injects after navigation (document-start)', await inState('agent'));
  await clickSel('#btn2');
  check('BLOCK holds on the new document', (await ev('document.title')) === 'second page');
  await pl('window.__pageLab.pass(3000)');
  await clickSel('#btn2');
  check('PASS holds on the new document', (await ev('document.title')) === 'second clicked');

  // -- Esc is barge-in -----------------------------------------------------------------------
  await navigate(`${base}/index.html`);
  await inState('agent');
  await key('Escape', 'Escape', 27);
  check('Esc: page state flips to human at once', (await pl('window.__pageLab.state')) === 'human');
  check('Esc: daemon records it in the stamp', await waitFor(async () => sup(['state']).stdout.trim() === 'human'));
  check('Esc: `state` exits 10 while human', sup(['state']).status === 10);
  const refused = await pl('window.__pageLab.pass(3000)');
  check('Esc: pass() refuses (ok:false) while human', refused?.ok === false && refused.state === 'human');
  await clickSel('#btn'); // no window, no layer: the operator drives
  check('Esc: operator input lands once the layer is gone', (await ev(`document.getElementById('n').textContent`)) === '1');
  check('Esc: `arm` refuses to take control back', sup(['arm']).status === 10);
  await navigate(`${base}/second.html`);
  check('human state survives navigation', (await pl('window.__pageLab.state')) === 'human');
  const w = spawnSync(process.execPath, [SUP, 'wait', '--timeout', '1'], { encoding: 'utf8', env: CLEAN_ENV });
  check('wait times out with exit 20 while human', w.status === 20);

  // -- hand-back chip ---------------------------------------------------------------------------
  const vp = await ev(`({w:innerWidth,h:innerHeight})`);
  await click(vp.w - 60, vp.h - 30); // the "Hand back to Claude" button
  check('chip click hands control back (agent)', await waitFor(async () => sup(['state']).stdout.trim() === 'agent'));
  check('wait returns 0 once agent', spawnSync(process.execPath, [SUP, 'wait', '--timeout', '3'], { encoding: 'utf8', env: CLEAN_ENV }).status === 0);
  check('layer is back after hand-back', await inState('agent'));

  // -- the pill is a barge-in target too (Esc needs keyboard focus in the window; a click does not) --------
  await click(vp.w / 2, 18);
  check('pill click is barge-in (no keyboard focus needed)', (await pl('window.__pageLab.state')) === 'human');
  sup(['arm', '--force']);
  await inState('agent');

  // -- Esc inside a window still barges in, unless the agent opted in ------------------------------
  await navigate(`${base}/index.html`);
  await inState('agent');
  await pl('window.__pageLab.pass(4000,{keys:["Escape"]})');
  await key('Escape', 'Escape', 27);
  check('agent-opted Esc passes to the page and does NOT barge', (await ev('document.title')) === 'page saw Escape' && (await pl('window.__pageLab.state')) === 'agent');
  await pl('window.__pageLab.pass(4000)');
  await key('Escape', 'Escape', 27);
  check('default window: Esc still barges in', (await pl('window.__pageLab.state')) === 'human');
  sup(['arm', '--force']);
  await inState('agent');

  // -- need-human -----------------------------------------------------------------------------------------
  const runNeed = (args) => {
    const child = spawn(process.execPath, [SUP, 'need-human', '--tab', targetId, ...args], {
      env: { ...CLEAN_ENV, PAGE_LAB_SUPERVISE_NO_OSASCRIPT: '1' },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const done = new Promise((r) => child.on('close', (code) => r({ code, out })));
    return { done };
  };

  // (a) resolves when the --until URL appears; control comes back WITHOUT any operator message
  await navigate(`${base}/index.html`);
  await inState('agent');
  const a = runNeed(['--reason', 'selftest login', '--until', 'url:done=1', '--timeout', '30']);
  check('need-human: page goes to intervene with the banner', await inState('intervene'));
  check('need-human: `state` exits 11', sup(['state']).status === 11);
  await clickSel('#btn'); // the operator works the page freely during intervention
  check('need-human: operator input lands (layer off)', (await ev(`document.getElementById('n').textContent`)) === '1');
  await navigate(`${base}/index.html?done=1`); // the operator "finishes the login"
  const ra = await a.done;
  const ja = JSON.parse(ra.out.trim().split('\n').pop());
  check('need-human: returns 0, resolved by --until', ra.code === 0 && ja.resolved === 'until', ra.out.trim());
  check('need-human: re-arms the layer on return', ja.state === 'agent' && (await inState('agent')));

  // (b) Done button
  const b = runNeed(['--reason', 'selftest captcha', '--timeout', '30']);
  await inState('intervene');
  const vp2 = await ev(`({w:innerWidth})`);
  await click(vp2.w - 40, 20); // the banner's Done button
  const rb = await b.done;
  check('need-human: Done button resolves it', rb.code === 0 && JSON.parse(rb.out.trim()).resolved === 'done', rb.out.trim());

  // (c) timeout leaves the operator in control and says so
  const c = runNeed(['--reason', 'selftest timeout', '--timeout', '2']);
  const rc = await c.done;
  check('need-human: timeout exits 20 and leaves the banner up', rc.code === 20 && (await pl('window.__pageLab.state')) === 'intervene');
  sup(['arm', '--force']);

  // (d) raise-once guard: the stamp is written before the raise, and a repeat is suppressed
  const d1 = spawnSync(process.execPath, [SUP, 'need-human', '--tab', targetId, '--reason', `selftest raise ${RUN}`, '--timeout', '1'], { encoding: 'utf8', env: { ...CLEAN_ENV, PAGE_LAB_SUPERVISE_NO_OSASCRIPT: '1' } });
  const d2 = spawnSync(process.execPath, [SUP, 'need-human', '--tab', targetId, '--reason', `selftest raise ${RUN}`, '--timeout', '1'], { encoding: 'utf8', env: { ...CLEAN_ENV, PAGE_LAB_SUPERVISE_NO_OSASCRIPT: '1' } });
  const r1 = JSON.parse(d1.stdout.trim()).raised;
  const r2 = JSON.parse(d2.stdout.trim()).raised;
  check('raise-once: first call would raise, repeat is suppressed', /^dry-run/.test(r1) && r2 === 'suppressed-already-raised', `${r1} / ${r2}`);
  sup(['arm', '--force']);

  // (e) THE BUG (2026-11-02): the agent opens a BACKGROUND tab and calls need-human; the banner
  // must land on THAT tab, and the tab must come to the front. A is the tab the operator is
  // looking at (no focus emulation, so visibilityState is the real "is selected" signal).
  const mkTab = async (url) => {
    const t = (await client.send('Target.createTarget', { url, background: true })).targetId;
    return { targetId: t, sid: await attach(client, t) };
  };
  const evOn = async (t, expression) => {
    const r = await client.send('Runtime.evaluate', { expression, returnByValue: true }, t.sid);
    return r.exceptionDetails ? undefined : r.result.value;
  };
  const infoOn = async (t) => JSON.parse((await evOn(t, 'JSON.stringify(window.__pageLab&&window.__pageLab.info())')) ?? 'null');
  const A = await mkTab(`${base}/second.html`);
  await client.send('Target.activateTarget', { targetId: A.targetId }); // setup: A is the visible tab
  const opened = JSON.parse(sup(['open', `${base}/index.html?hidden=${RUN}`]).stdout.trim());
  const B = { targetId: opened.targetId, sid: await attach(client, opened.targetId) };
  const bothArmed = await waitFor(async () => (await infoOn(A))?.state === 'agent' && (await infoOn(B))?.state === 'agent');
  check('background tab: `open` leaves A visible and B hidden', bothArmed && (await evOn(A, 'document.visibilityState')) === 'visible' && (await evOn(B, 'document.visibilityState')) === 'hidden');
  const e = spawn(process.execPath, [SUP, 'need-human', '--reason', `selftest background ${RUN}`, '--until', 'url:cleared=1', '--timeout', '30'], {
    env: { ...CLEAN_ENV, PAGE_LAB_SUPERVISE_NO_OSASCRIPT: '1' },
  });
  let eOut = '';
  e.stdout.on('data', (d) => (eOut += d));
  const eDone = new Promise((r) => e.on('close', (code) => r({ code, out: eOut })));
  check('need-human (no --tab) targets the tab opened last: B carries the banner', await waitFor(async () => (await infoOn(B))?.banner === true));
  check('need-human: B became the selected tab, A did not', (await evOn(B, 'document.visibilityState')) === 'visible' && (await evOn(A, 'document.visibilityState')) === 'hidden');
  const ia = await infoOn(A);
  check('need-human: the previously visible tab has NO banner, but is held (pass refuses)', ia.banner === false && ia.state === 'intervene' && (await evOn(A, 'JSON.stringify(window.__pageLab.pass(1000))')).includes('"ok":false'));
  // --until is judged on the target only: the URL appearing on A must not resolve it
  await client.send('Page.navigate', { url: `${base}/index.html?cleared=1` }, A.sid);
  await sleep(1500);
  check('need-human: --until on ANOTHER tab does not resolve it', (await infoOn(B))?.state === 'intervene');
  await client.send('Page.navigate', { url: `${base}/index.html?cleared=1` }, B.sid);
  const re = await eDone;
  const je = JSON.parse(re.out.trim().split('\n').pop());
  check('need-human: resolved by --until on the target tab', re.code === 0 && je.resolved === 'until' && je.tab.targetId === B.targetId && je.tab.activated === true, re.out.trim());
  check('need-human: banner gone from B and layer re-armed on both', await waitFor(async () => (await infoOn(B))?.state === 'agent' && (await infoOn(A))?.state === 'agent' && (await infoOn(B)).banner === false));

  // (f) explicit --tab by URL substring beats the implicit one; a miss changes nothing
  const miss = spawnSync(process.execPath, [SUP, 'need-human', '--tab', `no-such-tab-${RUN}`, '--reason', 'selftest miss', '--timeout', '1'], { encoding: 'utf8', env: { ...CLEAN_ENV, PAGE_LAB_SUPERVISE_NO_OSASCRIPT: '1' } });
  check('need-human: --tab that matches nothing exits 1 and shows no banner', miss.status === 1 && (await infoOn(A)).state === 'agent' && (await infoOn(B)).state === 'agent', miss.stderr.split('\n')[0]);
  await client.send('Page.navigate', { url: `${base}/second.html?a=${RUN}` }, A.sid);
  await sleep(500);
  const f1 = spawnSync(process.execPath, [SUP, 'need-human', '--tab', `a=${RUN}`, '--reason', `selftest explicit ${RUN}`, '--timeout', '1'], { encoding: 'utf8', env: { ...CLEAN_ENV, PAGE_LAB_SUPERVISE_NO_OSASCRIPT: '1' } });
  check('need-human: --tab <url-substring> targets that tab and activates it', f1.status === 20 && JSON.parse(f1.stdout.trim()).tab.targetId === A.targetId && (await infoOn(A)).banner === true && (await evOn(A, 'document.visibilityState')) === 'visible', f1.stdout.trim());
  sup(['arm', '--force']);

  // (g) `__pageLab.pass` on a tab makes it the default target (the "driven" half of lastTab)
  await evOn(B, 'window.__pageLab.pass(500)');
  await sleep(600);
  const g = spawnSync(process.execPath, [SUP, 'need-human', '--reason', `selftest driven ${RUN}`, '--timeout', '1'], { encoding: 'utf8', env: { ...CLEAN_ENV, PAGE_LAB_SUPERVISE_NO_OSASCRIPT: '1' } });
  check('need-human: a tab the agent drove via pass() is the default target', JSON.parse(g.stdout.trim()).tab.targetId === B.targetId, g.stdout.trim());
  sup(['arm', '--force']);
  for (const t of [A, B]) await client.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
} finally {
  sup(['stop']);
  try {
    if (targetId) await client.send('Target.closeTarget', { targetId });
  } catch {
    /* tab already gone */
  }
  client.close();
  server.close();
}

const failed = results.filter((r) => !r).length;
process.stdout.write(`\n${results.length - failed}/${results.length} checks held\n`);
process.exit(failed ? 1 : 0);
