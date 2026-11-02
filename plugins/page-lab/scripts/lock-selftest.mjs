#!/usr/bin/env node
// Does the lock WORK? Two halves, both on a local fixture, against a THROWAWAY Chromium.
//
//   node lock-selftest.mjs --browser-url http://127.0.0.1:9333
//
// Never point this at the operator's browser: it opens and closes tabs of its own.
// Operator and agent input are indistinguishable at the CDP layer [F-LOCK-TRUSTED-SAME], so
// "operator input" below is a trusted event sent WITHOUT arming a pass window, and "agent
// input" is the same event sent INSIDE one.
//   1. raw CDP     — the lock's own behaviour, event by event.
//   2. real MCP    — the agent's actual path: chrome-devtools-mcp (stdio) running lock.js through
//                    evaluate_script, click/fill/press_key by uid, navigate_page with initScript.
// Exit 0 = every check held; 1 = a check failed.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { attach, browserSocket, connect } from './lib/cdp.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const argv = process.argv.slice(2);
const browserUrl = argv[argv.indexOf('--browser-url') + 1] || 'http://127.0.0.1:9333';
const LOCK = readFileSync(`${HERE}lock.js`, 'utf8'); // the shipped file, verbatim
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}\n`);
};

const server = createServer((req, res) => {
  const name = req.url.split('?')[0] === '/second.html' ? 'second.html' : 'index.html';
  res.setHeader('content-type', 'text/html');
  res.end(readFileSync(`${HERE}fixtures/lock/${name}`));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const client = await connect(await browserSocket(browserUrl));
let targetId;
let mcp;
try {
  // ======================= 1. raw CDP =======================
  targetId = (await client.send('Target.createTarget', { url: 'about:blank', background: true })).targetId;
  const sid = await attach(client, targetId);
  await client.send('Page.enable', {}, sid);
  await client.send('Runtime.enable', {}, sid);
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sid); // [F-FOCUS-EMULATION]

  const ev = async (expression) => {
    const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value;
  };
  const lock = () => ev(`(${LOCK})()`);
  const state = () => ev('window.__pageLock ? window.__pageLock.state : "none"');
  const pass = (ms, o = {}) => ev(`JSON.stringify(window.__pageLock.pass(${ms}, ${JSON.stringify(o)}))`).then(JSON.parse);
  const num = () => ev(`document.getElementById('n').textContent`);
  const val = () => ev(`document.getElementById('txt').value`);
  const mouse = (type, x, y, extra = {}) =>
    client.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0, ...extra }, sid);
  const click = async (x, y) => {
    await mouse('mouseMoved', x, y);
    await mouse('mousePressed', x, y);
    await mouse('mouseReleased', x, y);
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
  const wheel = () => mouse('mouseWheel', 300, 300, { deltaX: 0, deltaY: 400 });
  const waitFor = async (fn, ms = 4000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(80)) if (await fn().catch(() => false)) return true;
    return false;
  };
  const navigate = async (url) => {
    await client.send('Page.navigate', { url }, sid);
    await waitFor(async () => (await ev('location.href')) === url && (await ev('document.readyState')) === 'complete');
  };
  const hitTag = async (sel) => {
    const c = await center(sel);
    return ev(`document.elementFromPoint(${c.x},${c.y}).id`);
  };

  await navigate(`${base}/index.html`);
  check('before lock: nothing in the way', (await state()) === 'none' && (await hitTag('#btn')) === 'btn');
  check('lock() returns "locked"', (await lock()) === 'locked');
  check('lock() is idempotent', (await lock()) === 'locked');
  check('the layer covers the page (hit-test no longer reaches the button)', (await hitTag('#btn')) !== 'btn');

  // -- rule 1: the operator is locked out ------------------------------------------------------
  await clickSel('#btn');
  await wheel();
  await ev(`document.getElementById('txt').focus()`);
  await key('a', 'KeyA', 65);
  await typeText('z');
  await sleep(150);
  check('LOCKED: operator click does not land', (await num()) === '0', `clicks=${await num()}`);
  check('LOCKED: operator key + insertText do not land in a focused field', (await val()) === '', `value="${await val()}"`);
  check('LOCKED: operator wheel does not scroll', (await ev('scrollY')) === 0, `scrollY=${await ev('scrollY')}`);
  await clickSel('#btn');
  check('LOCKED: a click on the layer does not blur the focused field', (await ev('document.activeElement.id')) === 'txt');

  // -- the agent's actions still work, inside a pass window ------------------------------------
  const p = await pass(3000);
  check('PASS: pass() returns ok:true while locked', p.ok === true && p.state === 'locked');
  check('PASS: the button is reachable inside the window', (await hitTag('#btn')) === 'btn');
  await clickSel('#btn');
  await ev(`document.getElementById('txt').focus()`);
  await key('a', 'KeyA', 65);
  await typeText('b');
  await wheel();
  await sleep(250);
  check('PASS: trusted click lands inside the window', (await num()) === '1', `clicks=${await num()}`);
  check('PASS: trusted key + insertText land inside the window', (await val()).endsWith('b'), `value="${await val()}"`);
  check('PASS: wheel scrolls inside the window', (await ev('scrollY')) > 0);
  await ev('scrollTo(0,0)');
  await pass(300);
  await sleep(700);
  await clickSel('#btn');
  check('the window shuts itself, and the layer is back', (await num()) === '1' && (await hitTag('#btn')) !== 'btn');

  // -- rule 2a: the agent is done -------------------------------------------------------------------
  check('unlock() returns "unlocked" and removes the global', (await ev('window.__pageLock.unlock()')) === 'unlocked' && (await state()) === 'none');
  await clickSel('#btn');
  await ev(`document.getElementById('txt').focus()`);
  await typeText('c');
  check('UNLOCKED: operator input lands again, button reachable', (await num()) === '2' && (await val()).endsWith('c') && (await hitTag('#btn')) === 'btn');

  // -- rule 2b: Esc ends it at once -------------------------------------------------------------------
  await lock();
  await key('Escape', 'Escape', 27);
  check('Esc: state is "released" before the handler returns, global kept', (await state()) === 'released');
  check('Esc: the page did not see the operator Escape', (await ev('document.title')) === 'lock fixture');
  await clickSel('#btn');
  check('Esc: operator input lands, button reachable', (await num()) === '3' && (await hitTag('#btn')) === 'btn');
  check('Esc: pass() refuses (ok:false) so the agent knows to stop', (await pass(3000)).ok === false);
  check('Esc: a repeat lock() does NOT re-lock (stays gone until unlock + lock)', (await lock()) === 'released' && (await hitTag('#btn')) === 'btn');
  await ev('window.__pageLock.unlock()');
  check('Esc: explicit unlock() then lock() locks again', (await lock()) === 'locked' && (await hitTag('#btn')) !== 'btn');

  // -- Esc from the agent -----------------------------------------------------------------------------------
  await pass(4000, { keys: ['Escape'] });
  await key('Escape', 'Escape', 27);
  check('agent Escape with pass(…,{keys:["Escape"]}) reaches the page and does NOT unlock', (await ev('document.title')) === 'page saw Escape' && (await state()) === 'locked');
  await pass(4000);
  await key('Escape', 'Escape', 27);
  check('agent Escape in a default window DOES unlock (indistinguishable from the operator\'s)', (await state()) === 'released');
  await ev('window.__pageLock.unlock()');

  // -- the label is a second way out (Esc needs keyboard focus in the page) ---------------------------------------
  await lock();
  const vp = await ev(`({w:innerWidth})`);
  await click(vp.w / 2, 18);
  check('label click releases the lock (no keyboard focus needed)', (await state()) === 'released');
  await ev('window.__pageLock.unlock()');

  // -- navigation: what survives ----------------------------------------------------------------------------------------
  await lock();
  await pass(5000);
  await clickSel('#next');
  await waitFor(async () => (await ev('location.pathname')) === '/second.html' && (await ev('document.readyState')) === 'complete');
  check('NAV: a link click inside the window navigates', (await ev('location.pathname')) === '/second.html');
  check('NAV: the lock does NOT survive the new document (re-run lock)', (await state()) === 'none');
  check('NAV: re-running lock() on the new document locks it', (await lock()) === 'locked');
  await clickSel('#btn2');
  check('NAV: and operator input is blocked there', (await ev('document.title')) === 'second page');
  await ev('window.__pageLock.unlock()');

  // initScript is the document-start path (what navigate_page's initScript does)
  const { identifier } = await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${LOCK})()` }, sid);
  await client.send('Page.navigate', { url: `${base}/index.html?docstart` }, sid);
  check('NAV: a document-start injection has the lock by load', await waitFor(async () => (await state()) === 'locked' && (await ev('document.readyState')) !== 'loading'));
  check('NAV: and the layer is mounted (hit-test)', await waitFor(async () => (await hitTag('#btn')) !== 'btn'));
  await ev('window.__pageLock.unlock()');
  await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sid);

  // ======================= 2. the real MCP =======================
  await client.send('Target.closeTarget', { targetId });
  targetId = undefined;
  mcp = spawn('npx', ['-y', 'chrome-devtools-mcp@1.12.0', `--browser-url=${browserUrl}`, '--no-usage-statistics', '--no-performance-crux'], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  let nextId = 0;
  const waiting = new Map();
  mcp.stdout.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        if (m.id && waiting.has(m.id)) waiting.get(m.id)(m), waiting.delete(m.id);
      } catch {
        /* not a JSON-RPC frame */
      }
    }
  });
  const rpc = (method, params) => new Promise((r) => { const id = ++nextId; waiting.set(id, r); mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return (r.result?.content ?? []).map((c) => c.text ?? '').join('\n') || JSON.stringify(r.error ?? r.result);
  };
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'lock-selftest', version: '1' } });
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const uidOf = (snap, re) => (snap.match(new RegExp(`uid=(\\S+) ${re}`)) ?? [])[1];
  // evaluate_script answers with a fenced ```json block; take the first JSON value in it
  const evalMcp = async (pageId, fn) => {
    const out = await tool('evaluate_script', { pageId, function: fn });
    const m = out.match(/```json\s*([\s\S]*?)```/);
    return m ? JSON.parse(m[1]) : out;
  };
  const pagesList = async () => [...(await tool('list_pages')).matchAll(/^(\d+): (\S+)/gm)].map((m) => ({ id: Number(m[1]), url: m[2] }));

  await tool('new_page', { url: `${base}/index.html`, background: true });
  const pid = (await pagesList()).at(-1).id;
  await sleep(500);
  const snapshot = async () => {
    const s = await tool('take_snapshot', { pageId: pid });
    return { btn: uidOf(s, 'button "Click me"'), txt: uidOf(s, 'textbox'), next: uidOf(s, 'link "go to second page"') };
  };
  const read = () => evalMcp(pid, '() => ({n: document.getElementById("n").textContent, v: document.getElementById("txt").value})');
  let uids = await snapshot();

  const lockResult = await evalMcp(pid, LOCK.trim());
  check('MCP: evaluate_script runs lock.js verbatim and returns "locked"', lockResult === 'locked', JSON.stringify(lockResult));
  await tool('click', { pageId: pid, uid: uids.btn });
  await tool('fill', { pageId: pid, uid: uids.txt, value: 'blocked' });
  let s = await read();
  check('MCP: click is swallowed with no window', s.n === '0', `clicks=${s.n}`);
  check('MCP: fill is swallowed with no window', s.v === '', `value="${s.v}"`);

  const pr = await evalMcp(pid, '() => __pageLock.pass(6000)');
  check('MCP: `() => __pageLock.pass(6000)` opens a window', pr.ok === true);
  const t0 = Date.now();
  await tool('click', { pageId: pid, uid: uids.btn });
  await tool('fill', { pageId: pid, uid: uids.txt, value: 'passed' });
  await tool('press_key', { pageId: pid, key: 'X' });
  s = await read();
  check('MCP: click lands inside the window', s.n === '1', `clicks=${s.n}`);
  check('MCP: fill lands inside the window', s.v.startsWith('passed'), `value="${s.v}"`);
  check('MCP: press_key lands inside the window', s.v.length > 'passed'.length, `value="${s.v}"`);
  process.stdout.write(`      pass → click → fill → press_key: ${Date.now() - t0} ms of MCP round trips (no model think time)\n`);

  // navigation through the MCP
  await tool('navigate_page', { pageId: pid, type: 'url', url: `${base}/second.html` });
  check('MCP NAV: navigate_page without initScript leaves the new document unlocked', (await evalMcp(pid, '() => window.__pageLock ? window.__pageLock.state : "none"')) === 'none');
  await tool('navigate_page', { pageId: pid, type: 'url', url: `${base}/index.html`, initScript: `(${LOCK})()` });
  check('MCP NAV: navigate_page with initScript has the lock on the new document', (await evalMcp(pid, '() => window.__pageLock ? window.__pageLock.state : "none"')) === 'locked');
  await tool('navigate_page', { pageId: pid, type: 'url', url: `${base}/second.html` });
  check('MCP NAV: initScript covers ONLY that navigation (the next one is unlocked)', (await evalMcp(pid, '() => window.__pageLock ? window.__pageLock.state : "none"')) === 'none');

  // Escape through the MCP
  await tool('navigate_page', { pageId: pid, type: 'url', url: `${base}/index.html` });
  await evalMcp(pid, LOCK.trim());
  await evalMcp(pid, '() => __pageLock.pass(6000, {keys: ["Escape"]})');
  await tool('press_key', { pageId: pid, key: 'Escape' });
  check('MCP: press_key Escape inside pass(…,{keys:["Escape"]}) does not unlock', (await evalMcp(pid, '() => __pageLock.state')) === 'locked');
  await evalMcp(pid, '() => __pageLock.pass(6000)');
  await tool('press_key', { pageId: pid, key: 'Escape' });
  check('MCP: press_key Escape in a default window unlocks (as documented)', (await evalMcp(pid, '() => __pageLock.state')) === 'released');
  check('MCP: unlock via evaluate_script', (await evalMcp(pid, '() => __pageLock.unlock()')) === 'unlocked');
  await tool('close_page', { pageId: pid }).catch(() => {});
} finally {
  try {
    if (targetId) await client.send('Target.closeTarget', { targetId });
  } catch {
    /* tab already gone */
  }
  client.close();
  server.close();
  if (mcp) mcp.kill();
}

const failed = results.filter((r) => !r).length;
process.stdout.write(`\n${results.length - failed}/${results.length} checks held\n`);
process.exit(failed ? 1 : 0);
