// Acceptance primitives for driving a userscript against a live page over raw CDP.
//
// Why this exists: selector-verify.mjs answers "is the node there?". Nothing answered
// "does the control still WORK?" — and that is the gap a real script shipped through.
// google-photos-icon-nav 3.0.0 passed every geometry and hit-test check with its search
// completely dead: the node was present, sized and hit-testable, and clicking it did
// nothing [F-PRESENT-NOT-WORKING]. Geometry proves presence, never behaviour.
//
// So the primitive here is the TRUSTED event. Input.dispatchMouseEvent goes through the
// browser's real input pipeline; el.click() does not, and a synthetic click will happily
// "succeed" against a control the user cannot actually operate.
//
// Not an entrypoint. Importer: userscript-acceptance.mjs.

import { attach, browserSocket, connect } from './cdp.mjs';

/** No page target matched the spec's urlMatch. */
export const EXIT_NO_TARGET = 3;

/** Sentinel: a first read can never match it, so the first poll is never 'stable'. */
const NO_VALUE = Symbol('no-value');

/** Modifier bit for the platform's "select all" chord — Meta on darwin, Ctrl elsewhere. */
const ACCEL = process.platform === 'darwin' ? 4 : 2;

/**
 * Attach to the first page target whose URL contains `urlMatch`, and return the verbs a
 * spec is written against.
 *
 * `--target-id` is not offered here the way selector-verify.mjs offers it, because the
 * spec names its own site: matching on URL is both the disambiguation and the assertion
 * that we are on the right page. That matters — a debug browser routinely holds several
 * page targets (a userscript manager alone contributes two), and "the first page target"
 * silently scores against one of them [F-FIRST-TARGET-WRONG].
 */
export async function attachPage(urlMatch, { browserUrl = 'http://127.0.0.1:9222' } = {}) {
  const client = await connect(await browserSocket(browserUrl));
  const { targetInfos } = await client.send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page' && t.url.includes(urlMatch));
  if (page === undefined) {
    const seen = targetInfos.filter((t) => t.type === 'page').map((t) => t.url);
    const err = new Error(
      `harness: no page target matching ${JSON.stringify(urlMatch)}.\n` +
        `  open page targets:\n${seen.map((u) => `    ${u}`).join('\n') || '    (none)'}`,
    );
    err.exitCode = EXIT_NO_TARGET;
    throw err;
  }
  const sessionId = await attach(client, page.targetId);

  /** Evaluate in the page. Throws the page-side exception rather than returning undefined. */
  const ev = async (expression) => {
    const r = await client.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, allowUnsafeEvalBlockedByCSP: true },
      sessionId,
    );
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails),
      );
    }
    return r.result.value;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // A trusted click: move, press, release. The move matters — controls that arm on
  // pointerover never arm if the pointer teleports onto them with the button already down.
  const click = async (x, y) => {
    const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 }, sessionId);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 }, sessionId);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 }, sessionId);
  };

  /** Click the centre of whatever `selector` resolves to. Returns the rect, or null. */
  const clickSelector = async (selector) => {
    const box = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});
      if(!e)return null;const b=e.getBoundingClientRect();
      return {x:b.x+b.width/2,y:b.y+b.height/2,w:Math.round(b.width),h:Math.round(b.height)}})()`);
    if (box === null) return null;
    await click(box.x, box.y);
    return box;
  };

  /** Characters, via `char` events — the path that reaches a controlled input. */
  const type = async (text) => {
    for (const ch of text) {
      await client.send('Input.dispatchKeyEvent', { type: 'char', text: ch }, sessionId);
    }
  };

  const KEYS = { Escape: 27, Enter: 13, Tab: 9, Backspace: 8, ArrowDown: 40, ArrowUp: 38 };
  const key = async (name, { modifiers = 0 } = {}) => {
    const code = KEYS[name] ?? 0;
    const base = { key: name, code: name, windowsVirtualKeyCode: code, modifiers };
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base }, sessionId);
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId);
  };

  const selectAll = () => key('a', { modifiers: ACCEL });

  return { client, sessionId, ev, sleep, click, clickSelector, type, key, selectAll, url: page.url };
}

/**
 * Poll `read` until it returns the same value `stableFor` times running, then return it.
 *
 * A fixed sleep RACES a CSS transition, and the failure is a false negative that looks
 * exactly like a real bug. Measured: a drawer on `transition: transform .18s` injected at
 * readyState "complete" read x=0 at 200ms and x=-88 at 800ms [F-TRANSITION-RACE].
 *
 * `stableFor` defaults to 2, which is enough for a linear transition. Raise it for anything
 * that grows in steps: an account popover read the SAME height twice mid-growth at 210px
 * before settling at 622px, so two equal reads were not proof it had finished.
 */
export async function settle(read, { tries = 25, gap = 120, stableFor = 2, accept = () => true } = {}) {
  let prev = NO_VALUE;
  let runs = 0;
  let value;
  for (let i = 0; i < tries; i += 1) {
    value = await read();
    const same = prev !== NO_VALUE && JSON.stringify(value) === JSON.stringify(prev);
    runs = same && accept(value) ? runs + 1 : 0;
    if (runs >= stableFor) return value;
    prev = value;
    await new Promise((r) => setTimeout(r, gap));
  }
  return value;
}

/**
 * Run a userscript's body in the page.
 *
 * The `// ==UserScript== … ==/UserScript==` block is metadata for the userscript manager,
 * not JavaScript, so it is stripped. Everything downstream of that is the real difference
 * between this and a genuine install, and specs must account for it: an install runs at
 * `@run-at document-start` against an empty document, while this runs against a fully
 * built one. Scripts that latch on first paint behave differently under the two.
 *
 * Re-injecting is ALSO the two-copy livelock test — a second run is exactly the Greasy Fork
 * install plus a manual one that a teardown contract exists to survive.
 */
export function userScriptBody(source) {
  return source.replace(/^\s*\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/m, '');
}

export async function inject(ev, source) {
  await ev(`(0,eval)(${JSON.stringify(userScriptBody(source))}); true`);
}

/**
 * Clear a CONTROLLED input — one whose framework owns `value` and reverts a plain
 * assignment. Measured on Google Photos' search field: `value = ''` was reverted, a
 * select-all chord was swallowed, and typed characters landed at the CARET rather than
 * being appended, so text accumulated across runs [F-CONTROLLED-INPUT]. The native setter
 * plus an `input` event is the path the framework does honour.
 */
export function clearControlledInputExpr(selector) {
  return `(()=>{const i=document.querySelector(${JSON.stringify(selector)});
    if(!i)return false;
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    set.call(i,'');
    i.dispatchEvent(new Event('input',{bubbles:true}));
    i.dispatchEvent(new Event('change',{bubbles:true}));
    return true})()`;
}

/** Collects results so the spec reads as assertions rather than as plumbing. */
export function createReport() {
  const results = [];
  return {
    results,
    check(name, pass, detail) {
      results.push({ name, pass: Boolean(pass), detail });
      return Boolean(pass);
    },
    print(label) {
      const passed = results.filter((r) => r.pass).length;
      process.stdout.write(`\n=== ${label} : ${passed}/${results.length} ===\n\n`);
      for (const r of results) {
        process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n`);
        if (!r.pass && r.detail !== undefined) {
          process.stdout.write(`      ${JSON.stringify(r.detail)}\n`);
        }
      }
      return passed === results.length;
    },
  };
}
