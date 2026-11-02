#!/usr/bin/env node
// Two measurements through the REAL chrome-devtools MCP server (stdio), not a stand-in:
//
//   1. FOCUS   — does each tool call change the frontmost macOS application? A control
//                (Page.bringToFront / Target.activateTarget) must change it, or the
//                instrument cannot disagree and "no change" means nothing.
//   2. DRIVING — does click / fill / press_key land through the supervise overlay only
//                after `__pageLab.pass()`, and are they swallowed without it?
//
//   node supervise-measure.mjs --browser-url http://127.0.0.1:9333
//
// Run against a THROWAWAY Chromium (own --user-data-dir + port), launched with
// `open -g -n -a Chromium --args --remote-debugging-port=9333 --user-data-dir=<tmp>`, while a
// NON-Chromium app is frontmost. It opens and closes tabs of its own. macOS only for (1).

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { attach, browserSocket, connect } from './lib/cdp.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const argv = process.argv.slice(2);
const browserUrl = argv[argv.indexOf('--browser-url') + 1] || 'http://127.0.0.1:9333';
const SUP = fileURLToPath(new URL('./supervise.mjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- frontmost-app probe: lsappinfo needs no Automation grant ------------------------------
const lsa = (...a) => execFileSync('/usr/bin/lsappinfo', a, { encoding: 'utf8' });
const front = () => {
  const asn = lsa('front').trim();
  const name = (lsa('info', '-only', 'name', asn).match(/^"([^"]+)"/) ?? [])[1] ?? '?';
  return { asn, name };
};
const bundleOf = (asn) => (lsa('info', '-only', 'bundleid', asn).match(/bundleID="([^"]+)"/) ?? [])[1];

// ---- fixture server -------------------------------------------------------------------------
const server = createServer((req, res) => {
  const f = req.url.split('?')[0] === '/second.html' ? 'second.html' : 'index.html';
  res.setHeader('content-type', 'text/html');
  res.end(readFileSync(`${HERE}fixtures/supervise/${f}`));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- MCP stdio client -------------------------------------------------------------------------
const mcp = spawn('npx', ['-y', 'chrome-devtools-mcp@1.12.0', `--browser-url=${browserUrl}`, '--no-usage-statistics', '--no-performance-crux'], { stdio: ['pipe', 'pipe', 'ignore'] });
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
await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'supervise-measure', version: '1' } });
mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

const pages = async () => [...(await tool('list_pages')).matchAll(/^(\d+): (\S+)/gm)].map((m) => ({ id: Number(m[1]), url: m[2] }));
const uidOf = (snap, re) => (snap.match(new RegExp(`uid=(\\S+) ${re}`)) ?? [])[1];

// ---- 1. FOCUS ------------------------------------------------------------------------------------
const rows = [];
const baseline = front();
const restoreBaseline = async () => {
  // Every probe must START with a non-Chromium app frontmost, or "quiet" proves nothing.
  if (front().name !== 'Chromium') return;
  try {
    const id = bundleOf(baseline.asn);
    if (id) execFileSync('/usr/bin/open', ['-b', id]);
  } catch {
    /* best effort */
  }
  await sleep(800);
};
const probe = async (label, fn) => {
  await restoreBaseline();
  const before = front();
  const out = await fn();
  await sleep(900); // a window raise is asynchronous
  const after = front();
  // 'stole' = Chromium BECAME frontmost. Any other change is the operator switching apps (noise).
  const stole = after.name === 'Chromium' && before.name !== 'Chromium';
  rows.push({ label, stole, now: after.name });
  process.stdout.write(`${stole ? 'STOLE ' : 'quiet '} ${label}${stole ? `  → frontmost is now ${after.name}` : ''}\n`);
  if (stole) await sleep(0);
  return out;
};
process.stdout.write(`frontmost at start: ${baseline.name} (${baseline.asn}); AppleSpacesSwitchOnActivate=${(() => { try { return execFileSync('/usr/bin/defaults', ['read', 'NSGlobalDomain', 'AppleSpacesSwitchOnActivate'], { encoding: 'utf8' }).trim(); } catch { return 'unset(default 1)'; } })()}\n`);

const client = await connect(await browserSocket(browserUrl));
const cdpTargets = async () => (await client.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page');

await probe('MCP list_pages', () => tool('list_pages'));
await probe('MCP new_page (default)', () => tool('new_page', { url: `${base}/index.html` }));
const ps = await pages();
const pDefault = ps[ps.length - 1].id;
await probe('MCP new_page background:true', () => tool('new_page', { url: `${base}/second.html`, background: true }));
const ps2 = await pages();
const pBg = ps2[ps2.length - 1].id;
await probe('MCP navigate_page (url)', () => tool('navigate_page', { pageId: pBg, type: 'url', url: `${base}/index.html` }));
const snap = await tool('take_snapshot', { pageId: pBg });
await probe('MCP take_snapshot', () => tool('take_snapshot', { pageId: pBg }));
await probe('MCP evaluate_script', () => tool('evaluate_script', { pageId: pBg, function: '() => document.title' }));
await probe('MCP take_screenshot', () => tool('take_screenshot', { pageId: pBg, format: 'png', filePath: `${process.env.TMPDIR || '/tmp'}/pl-measure.png` }));
const btn = uidOf(snap, 'button "Click me"');
const txt = uidOf(snap, 'textbox');
await probe('MCP click', () => tool('click', { pageId: pBg, uid: btn }));
await probe('MCP fill', () => tool('fill', { pageId: pBg, uid: txt, value: 'hello' }));
await probe('MCP press_key', () => tool('press_key', { pageId: pBg, key: 'Tab' }));
await probe('MCP select_page bringToFront:false', () => tool('select_page', { pageId: pBg, bringToFront: false }));
await probe('MCP select_page bringToFront:true', () => tool('select_page', { pageId: pBg, bringToFront: true }));
await probe('MCP close_page', () => tool('close_page', { pageId: pDefault }));

const ts = await cdpTargets();
const victim = ts.find((t) => t.url.includes('/index.html')) ?? ts[0];
const sid = await attach(client, victim.targetId);
await probe('CDP Target.createTarget {background:true}', () => client.send('Target.createTarget', { url: 'about:blank', background: true }));
await probe('CDP Emulation.setFocusEmulationEnabled', () => client.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sid));
await probe('CDP Input.dispatchMouseEvent (trusted click)', async () => {
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 }, sid);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 }, sid);
});
// CONTROL, last: this MUST steal, or the probe cannot disagree and every "quiet" above is void.
await probe('CONTROL CDP Page.bringToFront', () => client.send('Page.bringToFront', {}, sid));
const stoleControl = rows.at(-1).stole;
try {
  const id = bundleOf(baseline.asn);
  if (id) execFileSync('/usr/bin/open', ['-b', id]); // hand the operator back the app the control took
} catch { /* best effort */ }

// ---- 2. DRIVING through MCP ----------------------------------------------------------------------------
const sup = (...a) => spawn(process.execPath, ['--experimental-websocket', SUP, ...a, ...(a[0] === 'start' ? ['--browser-url', browserUrl] : [])], { stdio: ['ignore', 'pipe', 'inherit'] });
const supRun = (...a) => new Promise((r) => { let o = ''; const c = sup(...a); c.stdout.on('data', (d) => (o += d)); c.on('close', (code) => r({ code, o })); });
await supRun('start');
const results = [];
const check = (name, ok, d = '') => { results.push(ok); process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${d ? `  — ${d}` : ''}\n`); };

// Race: a tab created WITH a url may finish its first load before the daemon attaches.
await tool('new_page', { url: `${base}/index.html`, background: true });
const ps3 = await pages();
const pT = ps3[ps3.length - 1].id;
await sleep(800);
const hasLayerOnCreate = (await tool('evaluate_script', { pageId: pT, function: '() => window.__pageLab ? window.__pageLab.state : "absent"' })).includes('agent');
process.stdout.write(`new_page(url) → overlay on the FIRST document: ${hasLayerOnCreate ? 'yes' : 'NO (needs a navigation)'}\n`);
await tool('navigate_page', { pageId: pT, type: 'url', url: `${base}/index.html` });
await sleep(600);
check('overlay armed after navigate_page', (await tool('evaluate_script', { pageId: pT, function: '() => window.__pageLab && window.__pageLab.state' })).includes('agent'));
const s2 = await tool('take_snapshot', { pageId: pT });
const b2 = uidOf(s2, 'button "Click me"');
const t2 = uidOf(s2, 'textbox');
const read = async () => JSON.parse((await tool('evaluate_script', { pageId: pT, function: '() => JSON.stringify({n:document.getElementById("n").textContent,v:document.getElementById("txt").value})' })).replace(/^[^{]*```json\s*/s, '').replace(/```[\s\S]*$/, '').replace(/^"|"$/g, '').replace(/\\"/g, '"').match(/\{.*\}/)[0]);

await tool('click', { pageId: pT, uid: b2 });
await tool('fill', { pageId: pT, uid: t2, value: 'blocked' });
const bl = await read();
check('MCP click is swallowed with no window', bl.n === '0', `clicks=${bl.n}`);
check('MCP fill is swallowed with no window', bl.v === '', `value="${bl.v}"`);

await tool('evaluate_script', { pageId: pT, function: '() => window.__pageLab.pass(6000)' });
const t0 = Date.now();
await tool('click', { pageId: pT, uid: b2 });
await tool('fill', { pageId: pT, uid: t2, value: 'passed' });
await tool('press_key', { pageId: pT, key: 'X' });
const ps4 = await read();
check('MCP click lands inside the window', ps4.n === '1', `clicks=${ps4.n}`);
check('MCP fill lands inside the window', ps4.v.startsWith('passed'), `value="${ps4.v}"`);
check('MCP press_key lands inside the window', /X$/i.test(ps4.v) || ps4.v.length > 'passed'.length, `value="${ps4.v}"`);
process.stdout.write(`arm→click→fill→press_key took ${Date.now() - t0} ms of MCP round trips (excludes model think time)\n`);

await supRun('stop');
await tool('close_page', { pageId: pT }).catch(() => {});
const failed = results.filter((r) => !r).length;
process.stdout.write(`\nfocus control stole: ${stoleControl}; driving checks: ${results.length - failed}/${results.length}\n`);
client.close();
mcp.kill();
server.close();
process.exit(failed || !stoleControl ? 1 : 0);
