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
// Not an entrypoint. Importers: userscript-acceptance.mjs, redesign-acceptance.mjs,
// lib/redesign-checks.mjs.

import { attach, browserSocket, connect } from './cdp.mjs';

/** No page target matched the spec's urlMatch. */
export const EXIT_NO_TARGET = 3;

/** Sentinel: a first read can never match it, so the first poll is never 'stable'. */
const NO_VALUE = Symbol('no-value');

/** Modifier bit for the platform's "select all" chord — Meta on darwin, Ctrl elsewhere. */
const ACCEL = process.platform === 'darwin' ? 4 : 2;

/**
 * The verbs every spec is written against, bound to one attached target.
 *
 * Factored out of attachPage so a second entrypoint (openLab, below) gets the identical
 * trusted-input semantics rather than a second, subtly different copy. A hand-rolled
 * second driver is the exact anti-pattern this file exists to prevent.
 */
export function pageVerbs(client, sessionId) {
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

  /**
   * The first match that actually RENDERS, not merely the first match.
   *
   * A site may ship two elements matching the primary-surface selector, one of them inside
   * a `display:none` parent — a print or mobile duplicate, or a template. `querySelector`
   * happily returns the invisible one, and every geometry assertion downstream then reads
   * 0x0 and blames the redesign. Same rule the script's own host lookup must use.
   */
  const rendered = (selector) =>
    `(()=>{const all=[...document.querySelectorAll(${JSON.stringify(selector)})];
      return all.find(e=>{const r=e.getBoundingClientRect();
        return r.width>0&&r.height>0&&getComputedStyle(e).display!=='none';})||all[0]||null})()`;

  const box = (expr) => `(()=>{const e=${expr};if(!e)return null;
    const b=e.getBoundingClientRect();
    return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)}})()`;

  /**
   * Move the pointer, with no button, to an exact viewport point.
   *
   * The reveal trigger of an autohiding top bar is the pointer's POSITION, not a hover on
   * the bar itself — an off-canvas bar cannot be hovered — so a spec that wants to prove the
   * bar reveals has to be able to put the pointer a few pixels from the top edge and take it
   * away again.
   */
  const movePointer = (x, y) =>
    client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none', buttons: 0 },
      sessionId,
    );

  /**
   * Move the pointer somewhere harmless.
   *
   * Trusted input leaves the pointer PARKED where it last was, so a hover rule stays applied
   * across every later measurement. Reading a rest state with the pointer still sitting on
   * the element measures the hover state and calls it the rest state — a false failure that
   * reads exactly like a broken `opacity: 0`.
   *
   * The default `(1, 1)` is harmless for a card overlay and is NOT harmless for an
   * autohiding top bar: it parks inside the reveal band, so the bar's revealed state gets
   * read as its rest state. Pass a point away from the top edge for that
   * (`skills/site-redesign/topbar.md`).
   */
  const parkPointer = (x = 1, y = 1) => movePointer(x, y);

  /**
   * Click a control once it has STOPPED MOVING and is inside the viewport.
   *
   * Two failures this prevents, both of which present as "the control renders and does
   * nothing" — i.e. as the very defect the runner exists to catch, reported against
   * working code:
   *
   *   - A control that is still sliding in is clicked where it WAS [F-TRANSITION-RACE].
   *     Its rect is read the instant the opening click returns, and a drawer on a .18s
   *     transition is off-canvas for most of that.
   *   - A control BELOW THE FOLD is clicked at viewport coordinates the browser discards,
   *     because Input.dispatchMouseEvent takes viewport coordinates and does not scroll.
   *
   * Returns the rect plus `covered`: what is actually on top at that point, when it is not
   * the element. A covered control is a real defect — and a different one from a dead one.
   */
  const clickStable = async (selector, { tries = 25, gap = 120 } = {}) => {
    const sel = JSON.stringify(selector);
    const seen = await ev(`(()=>{const e=document.querySelector(${sel});
      if(!e)return null;
      const b=e.getBoundingClientRect();
      if(b.top<0||b.bottom>innerHeight)e.scrollIntoView({block:'center',behavior:'instant'});
      return true})()`);
    if (seen === null) return null;

    const ready = await settle(() => ev(box(`document.querySelector(${sel})`)), {
      tries,
      gap,
      stableFor: 2,
      accept: (b) => b !== null && b.w > 0 && b.h > 0 && b.x + b.w > 0 && b.y + b.h > 0,
    });
    if (ready === null) return null;

    const x = ready.x + ready.w / 2;
    const y = ready.y + ready.h / 2;
    const on = await ev(`(()=>{const e=document.querySelector(${sel});
      const p=document.elementFromPoint(${Math.round(x)},${Math.round(y)});
      if(!p)return 'nothing at the point';
      if(p===e||e.contains(p)||p.contains(e))return null;
      return p.tagName+'.'+String(p.className||'').trim().split(/\\s+/)[0]})()`);
    await click(x, y);
    return { ...ready, covered: on };
  };

  return {
    ev,
    sleep,
    click,
    clickSelector,
    clickStable,
    movePointer,
    parkPointer,
    type,
    key,
    selectAll,
    rendered,
    rect: (sel) => ev(box(`document.querySelector(${JSON.stringify(sel)})`)),
    renderedRect: (sel) => ev(box(rendered(sel))),
    count: (sel) => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`),
  };
}

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
  return { client, sessionId, ...pageVerbs(client, sessionId), url: page.url };
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

// ---------------------------------------------------------------------------------------
// document-start lab
//
// Everything above drives a page that is ALREADY LOADED. That is the wrong world for a
// redesign: the installed script runs at `@run-at document-start`, before the site's own
// JS, and a suite built on `eval`-into-a-loaded-page reported 0 failures on a build with
// five live defects [F-INJECT-IS-NOT-INSTALL]. The lab below exists so that doing the
// correct thing — fresh target, real navigations, injection at document-start — is less
// work than doing the wrong one.
// ---------------------------------------------------------------------------------------

/**
 * Wrap a userscript body so it runs at a userscript manager's document-start, not earlier.
 *
 * `Page.addScriptToEvaluateOnNewDocument` fires BEFORE `document.documentElement` exists
 * [F-DOCSTART-NO-DOCUMENTELEMENT] — earlier than any manager's `document-start`, where
 * `<html>` is already there. Unwrapped, a script whose first statement touches
 * `document.documentElement` throws under the probe and works on install: a false failure
 * that costs an afternoon. The MutationObserver defers to the first moment `<html>` exists,
 * which is the manager's timing exactly — `<body>` still null, site JS not yet run.
 */
export function documentStartSource(body) {
  return `(function(){var __plRun=function(){\n${body}\n};
  if(document.documentElement){__plRun();return;}
  var __plObs=new MutationObserver(function(){
    if(document.documentElement){__plObs.disconnect();__plRun();}});
  __plObs.observe(document,{childList:true});})();`;
}

/**
 * A fresh, BACKGROUND page target to measure in, with a live clock and real navigation.
 *
 * Fresh, not shared: a long-lived target shared by several agents can silently stop
 * delivering trusted press/release while still delivering `mouseMoved`, so every control
 * reads as "renders, does nothing" [F-INPUT-SILENTLY-DROPPED].
 *
 * Background, and NOT activated: a backgrounded tab stalls observers, makes `settle()`
 * confirm a stock value as "stable", and pins a frozen transition above author-`!important`
 * [F-IO-BACKGROUND-TAB], [F-BG-TAB-FREEZES-ANIM] — but `Target.activateTarget` is the wrong
 * remedy for that, because it steals the operator's window and makes concurrent agents
 * fight over which tab is frontmost. `Emulation.setFocusEmulationEnabled` removes the CAUSE
 * instead: the tab reports focused and visible, its clock ticks, and the window never comes
 * forward [F-FOCUS-EMULATION]. Trusted input lands on a non-activated target either way.
 */
export async function openLab({ browserUrl = 'http://127.0.0.1:9222', url = 'about:blank' } = {}) {
  const client = await connect(await browserSocket(browserUrl));
  const { targetId } = await client.send('Target.createTarget', { url, background: true });
  const sessionId = await attach(client, targetId);
  await client.send('Page.enable', {}, sessionId);
  await client.send('Runtime.enable', {}, sessionId);
  // Before anything is measured: an unfocused tab's frozen clock is the single most
  // productive source of false results in this whole file.
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);

  // Page-side exceptions are the single most useful thing a failing check can hand you,
  // and they are invisible unless captured before the navigation that throws them.
  const errors = [];
  client.on(
    'Runtime.exceptionThrown',
    (p) => {
      const d = p?.exceptionDetails;
      errors.push(String(d?.exception?.description ?? d?.text ?? '').slice(0, 300));
    },
    sessionId,
  );

  const verbs = pageVerbs(client, sessionId);
  const docStart = new Map();

  // Emulation state is sticky and shared with the operator's own DevTools
  // [F-STICKY-STATE], so the focus override ships paired with its clear, in close().

  /**
   * Register a document-start script. Returns its identifier.
   *
   * It does NOT run in the document that is open right now — only on the next navigation
   * [F-DOCSTART-NEXT-NAV]. A runner that registers and then measures without navigating
   * measures a page with no script at all, and reports stock as the redesign.
   */
  const addDocStart = async (source, { wrap = true } = {}) => {
    const { identifier } = await client.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: wrap ? documentStartSource(source) : source },
      sessionId,
    );
    docStart.set(identifier, true);
    return identifier;
  };

  const removeDocStart = async (identifier) => {
    if (identifier === undefined) {
      for (const id of [...docStart.keys()]) await removeDocStart(id);
      return;
    }
    await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sessionId);
    docStart.delete(identifier);
  };

  /**
   * A real navigation, awaited on `Page.loadEventFired` rather than slept through.
   *
   * `settleFor` then polls a readiness read — load fires before a listing has painted its
   * units, and a fixed sleep there races the same transition `settle()` exists for
   * [F-TRANSITION-RACE].
   */
  const navigate = async (target, { timeout = 30000, settleFor = null } = {}) => {
    const loaded = new Promise((resolve) => {
      const off = client.on(
        'Page.loadEventFired',
        () => {
          off();
          resolve('load');
        },
        sessionId,
      );
      setTimeout(() => {
        off();
        resolve('timeout');
      }, timeout);
    });
    errors.length = 0;
    await client.send('Page.navigate', { url: target }, sessionId);
    const how = await loaded;
    if (settleFor) await settle(settleFor.read ?? settleFor, settleFor.opts ?? {});
    return how;
  };

  const setWidth = async (width, height = 900) => {
    await client.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 0, mobile: false },
      sessionId,
    );
  };
  // Emulation state is sticky and shared with the operator's own DevTools
  // [F-STICKY-STATE], so every override ships paired with its clear.
  const clearWidth = () => client.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);

  return {
    client,
    sessionId,
    targetId,
    errors,
    ...verbs,
    settle,
    addDocStart,
    removeDocStart,
    navigate,
    setWidth,
    clearWidth,
    async close() {
      try {
        await clearWidth();
      } catch {
        /* the target may already be gone; the close below is what matters */
      }
      try {
        await client.send('Emulation.setFocusEmulationEnabled', { enabled: false }, sessionId);
      } catch {
        /* same: a gone target needs no clear */
      }
      // NEVER close the last page target: Chromium quits with its last tab, which takes the
      // debugging port down with it and strands every other agent sharing the browser —
      // their next call fails as a connect error that reads like a dead rig
      // [F-LAST-TAB-KILLS-BROWSER]. Park it on about:blank instead; an empty tab costs
      // nothing and keeps the port alive.
      try {
        const { targetInfos = [] } = await client.send('Target.getTargets');
        const pages = targetInfos.filter(
          (t) => t.type === 'page' && !String(t.url || '').startsWith('devtools://'),
        );
        if (pages.length <= 1) await client.send('Page.navigate', { url: 'about:blank' }, sessionId);
        else await client.send('Target.closeTarget', { targetId });
      } catch {
        /* already closed, or the browser is gone — either way there is nothing to tidy */
      }
      client.close();
    },
  };
}

/**
 * A measurement-only sheet that stops time, for colour reads.
 *
 * Not a fix and never shipped: a running animation outranks author-`!important`
 * [F-ANIMATION-BEATS-IMPORTANT], and a frozen mid-transition value read as a colour is a
 * measurement of the transition, not of the design. Adopted rather than injected because
 * `document.adoptedStyleSheets` sorts last [F-ADOPTED-SORTS-LAST].
 */
export function freezeMotion(ev) {
  return ev(`(()=>{const s=new CSSStyleSheet();
    s.replaceSync('*,*::before,*::after{transition:none!important;animation:none!important}');
    document.adoptedStyleSheets=[...document.adoptedStyleSheets,s];return true})()`);
}

/** Page-side WCAG helpers, as source. Relative luminance and contrast ratio, nothing else. */
const WCAG_JS = `const __L=c=>{const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};
    return 0.2126*f(c[0])+0.7152*f(c[1])+0.0722*f(c[2])};
  const __P=v=>{const m=/^rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)$/.exec(v||'');
    return m?[+m[1],+m[2],+m[3],m[4]===undefined?1:parseFloat(m[4])]:null};
  const __R=(a,b)=>{const h=Math.max(a,b),l=Math.min(a,b);return (h+0.05)/(l+0.05)};
  const __ground=n=>{let c=n;while(c&&c!==document.documentElement){
    const p=__P(getComputedStyle(c).backgroundColor);if(p&&p[3]>=0.5)return __L(p);
    c=c.parentElement}return 0};`;

/**
 * Every visible text-on-background pair, measured — not sampled, and not eyeballed.
 *
 * Key the verdict on the ratio, never on the colour name [F-CONTRAST-RATIO-ONLY]. Own UI
 * is excluded by selector because it is held to its own palette and would otherwise drown
 * the signal that matters: stock colour the theme failed to reach.
 *
 * @returns {Promise<{checked:number,lightBg:number,lowContrast:number,worst:Array,bodyBg:string}>}
 */
export function contrastAudit(
  ev,
  { exclude = null, minRatio = 4.5, lightness = 0.18, worstN = 5, dark = true } = {},
) {
  const skip = exclude ? `if(n.closest(${JSON.stringify(exclude)}))continue;` : '';
  const bgTest = dark ? `__L(bg)>${lightness}` : `__L(bg)<${1 - lightness}`;
  return ev(`(()=>{${WCAG_JS}
    let lightBg=0,lowContrast=0,checked=0;const worst=[];
    for(const n of document.querySelectorAll('body *')){
      ${skip}
      const cs=getComputedStyle(n);
      if(cs.display==='none'||cs.visibility==='hidden'||cs.opacity==='0')continue;
      const r=n.getBoundingClientRect();
      if(r.width<4||r.height<4)continue;
      if(r.bottom<0||r.top>innerHeight*3)continue;
      checked++;
      const bg=__P(cs.backgroundColor);
      if(bg&&bg[3]>=0.5&&${bgTest})lightBg++;
      const txt=(n.textContent||'').trim();
      if(txt&&n.children.length===0){
        const fg=__P(cs.color);
        if(fg&&fg[3]>=0.5){const ra=__R(__L(fg),__ground(n));
          if(ra<${minRatio}){lowContrast++;
            if(worst.length<${worstN})worst.push({ratio:+ra.toFixed(2),fg:cs.color,
              tag:n.tagName,chars:txt.length});}}}
    }
    return {checked,lightBg,lowContrast,worst,
      bodyBg:getComputedStyle(document.body).backgroundColor}})()`);
}

/**
 * Prove the input rig is alive before believing any null result.
 *
 * Listed first in every suite because it invalidates the others rather than competing with
 * them: a target that has stopped delivering press/release makes every working control read
 * as dead [F-INPUT-SILENTLY-DROPPED]. Choose an ON-SCREEN stock control — an off-canvas link
 * produces a false "rig dead", which is the same lie in the other direction.
 *
 * The probe defuses the click it dispatches (capture-phase `preventDefault`) so asserting
 * liveness on a link does not navigate away from the page under test.
 *
 * @returns {Promise<{ok:boolean,why:string,at?:{x:number,y:number}}>}
 */
export async function assertRig(lab, { selector = 'a[href]', timeout = 1500 } = {}) {
  const armed = await lab.ev(`(()=>{
    const all=[...document.querySelectorAll(${JSON.stringify(selector)})];
    const hit=all.find(e=>{const b=e.getBoundingClientRect();
      if(b.width<6||b.height<6)return false;
      if(b.x<0||b.y<0||b.right>innerWidth||b.bottom>innerHeight)return false;
      const p=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);
      return !!p&&(p===e||e.contains(p)||p.contains(e));});
    if(!hit)return null;
    window.__plRigHits=0;
    window.__plRigFn=e=>{window.__plRigHits++;e.preventDefault();e.stopPropagation();};
    document.addEventListener('click',window.__plRigFn,true);
    const b=hit.getBoundingClientRect();
    return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`);

  if (armed === null) {
    return {
      ok: false,
      why:
        `no ON-SCREEN element matched ${JSON.stringify(selector)} — this is a bad rig probe, ` +
        'not a dead rig. Pick a control that is visible in the viewport.',
    };
  }

  await lab.click(armed.x, armed.y);
  const hits = await settle(() => lab.ev('window.__plRigHits|0'), {
    tries: Math.ceil(timeout / 100),
    gap: 100,
    stableFor: 2,
    accept: (v) => v > 0,
  });
  await lab.ev(`(()=>{document.removeEventListener('click',window.__plRigFn,true);
    delete window.__plRigFn;delete window.__plRigHits;return true})()`);

  return hits > 0
    ? { ok: true, why: `stock control took a trusted click at ${armed.x},${armed.y}`, at: armed }
    : {
        ok: false,
        why:
          'a trusted click on a plain stock control registered ZERO click events. The RIG is ' +
          'dead, not the page — every null result from this target is unsound. Open a fresh ' +
          'target and re-run [F-INPUT-SILENTLY-DROPPED].',
        at: armed,
      };
}
