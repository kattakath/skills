#!/usr/bin/env node
// Does supervised driving WORK? — trusted-input proof, both halves, on a local fixture.
//
//   node supervise-selftest.mjs --browser-url http://127.0.0.1:9333
//
// Run it against a THROWAWAY Chromium (own --user-data-dir and port), never the operator's
// browser: it opens its own background tab, and starts and stops the supervise daemon.
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

const sup = (args, env = {}) =>
  spawnSync(process.execPath, ['--experimental-websocket', SUP, ...args, ...(args[0] === 'start' ? ['--browser-url', browserUrl] : [])], {
    encoding: 'utf8',
    env: { ...process.env, PAGE_LAB_SUPERVISE_NO_OSASCRIPT: '1', ...env },
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
  const w = spawnSync(process.execPath, ['--experimental-websocket', SUP, 'wait', '--timeout', '1'], { encoding: 'utf8' });
  check('wait times out with exit 20 while human', w.status === 20);

  // -- hand-back chip ---------------------------------------------------------------------------
  const vp = await ev(`({w:innerWidth,h:innerHeight})`);
  await click(vp.w - 60, vp.h - 30); // the "Hand back to Claude" button
  check('chip click hands control back (agent)', await waitFor(async () => sup(['state']).stdout.trim() === 'agent'));
  check('wait returns 0 once agent', spawnSync(process.execPath, ['--experimental-websocket', SUP, 'wait', '--timeout', '3'], { encoding: 'utf8' }).status === 0);
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
    const child = spawn(process.execPath, ['--experimental-websocket', SUP, 'need-human', ...args], {
      env: { ...process.env, PAGE_LAB_SUPERVISE_NO_OSASCRIPT: '1' },
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
  const d1 = spawnSync(process.execPath, ['--experimental-websocket', SUP, 'need-human', '--reason', `selftest raise ${RUN}`, '--timeout', '1'], { encoding: 'utf8', env: { ...process.env, PAGE_LAB_SUPERVISE_NO_OSASCRIPT: '1' } });
  const d2 = spawnSync(process.execPath, ['--experimental-websocket', SUP, 'need-human', '--reason', `selftest raise ${RUN}`, '--timeout', '1'], { encoding: 'utf8', env: { ...process.env, PAGE_LAB_SUPERVISE_NO_OSASCRIPT: '1' } });
  const r1 = JSON.parse(d1.stdout.trim()).raised;
  const r2 = JSON.parse(d2.stdout.trim()).raised;
  check('raise-once: first call would raise, repeat is suppressed', /^dry-run/.test(r1) && r2 === 'suppressed-already-raised', `${r1} / ${r2}`);
  sup(['arm', '--force']);
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
