/*
 * supervise-overlay.js — the ONE injected "supervised driving" page layer.
 *
 * Injected by supervise.mjs (daemon) with Page.addScriptToEvaluateOnNewDocument, wrapped by
 * harness.mjs documentStartSource() so it survives navigations, and evaluated once into the
 * document that is already open [F-DOCSTART-NEXT-NAV]. Never read by an importer.
 *
 * WHAT IT IS. A translucent click-and-key-swallowing layer while the agent drives, a prompt
 * banner while the agent needs the operator, and a small hand-back chip after the operator
 * took over. State is one of:
 *
 *   pending    no layer, nothing swallowed. The state before the daemon has spoken, and the
 *              state the page FALLS BACK TO if the daemon stops answering (fail-open: a dead
 *              supervisor must never lock the operator out of their own browser).
 *   agent      layer on. Operator pointer + keyboard swallowed. Esc (or a click on the pill)
 *              is barge-in.
 *   human      layer off, chip on. The agent must not act until the chip is pressed.
 *   intervene  layer off, prompt banner with the reason and a Done button. The banner shows on
 *              the ONE tab the intervention is about (PL.mine); every other tab is in the same state
 *              with no banner, so pass() still refuses there, but the operator is not told about a
 *              step that is not on that page.
 *
 * WHY A PASSTHROUGH WINDOW AND NOT isTrusted. CDP Input.dispatch* events are isTrusted=true,
 * so the page cannot tell the agent's click from the operator's. The agent therefore ARMS a
 * short window (`__pageLab.pass(ms)`), acts inside it, and the window shuts itself. This is
 * COOPERATIVE: nothing stops an agent that skips the arm from being swallowed, and nothing
 * stops the OPERATOR's input inside an open window from landing. Keep windows short.
 *
 * Esc inside a window still barges in, unless the window was opened with {keys:['Escape']}:
 * an agent that never sends Esc must not lose the operator's.
 *
 * Plain JS, no top-level let/const (the injection wrappers re-evaluate it), idempotent.
 */
(function () {
  if (window !== window.top) return; // top frame only; OOPIFs are not covered
  if (window.__pageLab && window.__pageLab.v) return;

  var PL = (window.__pageLab = {
    v: 1,
    state: 'pending',
    reason: '',
    mine: true,
    stats: { blockedPointer: 0, blockedKey: 0, passedPointer: 0, passedKey: 0 },
  });
  var passUntil = 0;
  var passKeys = null;
  var passOnce = false;
  var lastHb = Date.now();
  var host = null;
  var ui = {};
  var guard = null;

  var POINTER = ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'pointerdown', 'pointerup', 'auxclick', 'touchstart', 'touchend'];
  var KEYS = ['keydown', 'keyup', 'keypress', 'beforeinput', 'textInput', 'compositionstart'];

  function signal(ev, extra) {
    try {
      if (typeof window.__pageLabSignal === 'function') {
        window.__pageLabSignal(JSON.stringify(Object.assign({ ev: ev, url: location.href }, extra || {})));
        return true;
      }
    } catch (e) {
      /* the binding is gone with the daemon; fail-open is the heartbeat's job */
    }
    return false;
  }

  function passing() {
    return Date.now() < passUntil;
  }

  var STYLE =
    ':host{all:initial}*{box-sizing:border-box;font:13px/1.3 -apple-system,system-ui,sans-serif}' +
    '.layer{position:fixed;inset:0;background:rgba(56,120,255,.12);pointer-events:auto;cursor:not-allowed}' +
    '.pill,.chip,.bar{position:fixed;color:#fff;pointer-events:auto;z-index:1;border-radius:999px;' +
    'box-shadow:0 2px 10px rgba(0,0,0,.35)}' +
    '.pill{top:6px;left:50%;transform:translateX(-50%);background:rgba(20,40,110,.92);padding:5px 14px;cursor:pointer}' +
    '.chip{right:14px;bottom:14px;background:rgba(20,40,110,.95);padding:8px 14px;display:flex;gap:10px;align-items:center}' +
    '.bar{top:0;left:0;right:0;border-radius:0;background:#d97706;padding:10px 16px;display:flex;gap:14px;align-items:center;font-size:15px}' +
    '.bar .txt{flex:1}button{all:unset;cursor:pointer;background:#fff;color:#111;border-radius:6px;padding:4px 12px;font-weight:600}' +
    '.none{display:none!important}';

  function build() {
    if (host && host.isConnected) return;
    var root = document.documentElement;
    if (!root) return;
    host = document.createElement('div');
    host.id = '__pagelab-supervise';
    host.setAttribute('style', 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important');
    var sh = host.attachShadow({ mode: 'closed' });
    var st = document.createElement('style');
    st.textContent = STYLE;
    ui.layer = document.createElement('div');
    ui.layer.className = 'layer none';
    ui.pill = document.createElement('div');
    ui.pill.className = 'pill none';
    ui.chip = document.createElement('div');
    ui.chip.className = 'chip none';
    ui.chipText = document.createElement('span');
    ui.chipBtn = document.createElement('button');
    ui.chipBtn.textContent = 'Hand back to Claude';
    ui.chip.append(ui.chipText, ui.chipBtn);
    ui.bar = document.createElement('div');
    ui.bar.className = 'bar none';
    ui.barText = document.createElement('span');
    ui.barText.className = 'txt';
    ui.barBtn = document.createElement('button');
    ui.barBtn.textContent = 'Done';
    ui.bar.append(ui.barText, ui.barBtn);
    sh.append(st, ui.layer, ui.pill, ui.chip, ui.bar);
    root.appendChild(host);
    if (!guard) {
      // Site JS that strips unknown nodes must not silently end supervision.
      guard = new MutationObserver(function () {
        if (PL.state !== 'pending' && !host.isConnected) build();
      });
      guard.observe(root, { childList: true });
    }

    ui.layer.addEventListener('wheel', function (e) { if (!passing()) e.preventDefault(); }, { passive: false });
    ui.chipBtn.addEventListener('click', function () { setLocal('agent'); signal('hand-back'); });
    ui.barBtn.addEventListener('click', function () { signal('done'); });
    paint();
  }

  function show(el, on) {
    if (el) el.classList.toggle('none', !on);
  }

  function paint() {
    if (!host) return;
    var p = passing();
    show(ui.layer, PL.state === 'agent');
    ui.layer.style.pointerEvents = p ? 'none' : 'auto';
    show(ui.pill, PL.state === 'agent');
    ui.pill.style.pointerEvents = p ? 'none' : 'auto';
    ui.pill.textContent = p ? 'Claude is acting…' : 'Claude is driving — press Esc to take over';
    ui.chipText.textContent = 'You have control — Claude is paused';
    show(ui.chip, PL.state === 'human');
    ui.barText.textContent = 'Claude needs you: ' + (PL.reason || 'your input') + ' — press Done when finished';
    show(ui.bar, PL.state === 'intervene' && PL.mine);
  }

  function setLocal(state, reason) {
    PL.state = state;
    PL.reason = reason || '';
    passUntil = 0;
    if (state === 'pending') {
      show(ui.layer, false); show(ui.pill, false); show(ui.chip, false); show(ui.bar, false);
    } else {
      build();
      paint();
    }
  }

  function bargeIn(how) {
    setLocal('human'); // synchronous: the layer is gone before this handler returns
    signal('barge-in', { how: how });
  }

  // ---- swallowing ----------------------------------------------------------------------
  function onPointer(e) {
    if (PL.state !== 'agent') return;
    if (passing()) {
      PL.stats.passedPointer += 1;
      if (passOnce && e.type === 'click') passUntil = 0, paint();
      return;
    }
    // The swallow below runs first on window-capture, so the pill's own listener would never
    // fire; hit-test it by rect instead. (The closed shadow root hides the real target.)
    if (e.type === 'click' && ui.pill) {
      var r = ui.pill.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) bargeIn('pill');
    }
    PL.stats.blockedPointer += 1;
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  function onKey(e) {
    if (PL.state === 'intervene' && PL.escEnds && e.type === 'keydown' && e.key === 'Escape') {
      var t = e.target, tag = t && t.tagName;
      if (!(t && (t.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'))) signal('esc-done');
      return;
    }
    if (PL.state !== 'agent') return;
    if (e.key === 'Escape') {
      var agentEsc = passing() && passKeys && passKeys.indexOf('Escape') >= 0;
      if (!agentEsc) {
        if (e.type === 'keydown') bargeIn('esc');
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
    }
    if (passing()) {
      PL.stats.passedKey += 1;
      return;
    }
    PL.stats.blockedKey += 1;
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  var i;
  for (i = 0; i < POINTER.length; i += 1) window.addEventListener(POINTER[i], onPointer, { capture: true, passive: false });
  for (i = 0; i < KEYS.length; i += 1) window.addEventListener(KEYS[i], onKey, { capture: true, passive: false });
  window.addEventListener('wheel', function (e) { if (PL.state === 'agent' && !passing()) { e.preventDefault(); e.stopImmediatePropagation(); } }, { capture: true, passive: false });

  // ---- API -----------------------------------------------------------------------------
  /** Daemon/CLI side: apply a state. Idempotent. */
  PL._set = function (state, reason, escEnds, mine) {
    PL.escEnds = !!escEnds;
    var m = mine !== false;
    var moved = m !== PL.mine;
    PL.mine = m;
    if (state !== PL.state || (reason || '') !== PL.reason) setLocal(state, reason);
    else if (moved) paint();
    return PL.state;
  };
  /** Daemon heartbeat; also (re)applies the authoritative state. */
  PL._hb = function (state, reason, escEnds, mine) {
    lastHb = Date.now();
    return PL._set(state, reason, escEnds, mine);
  };
  /**
   * Agent side. Open a passthrough window of `ms` (default 6000, 100..30000). Returns
   * {ok, state, until}. ok:false means DO NOT ACT: the operator has control (or needs to).
   */
  PL.pass = function (ms, opts) {
    if (PL.state === 'human' || PL.state === 'intervene') return { ok: false, state: PL.state };
    var n = ms === 0 ? 0 : Math.min(30000, Math.max(100, Number(ms) || 6000));
    passUntil = n ? Date.now() + n : 0;
    passKeys = (opts && opts.keys) || null;
    passOnce = !!(opts && opts.once);
    paint();
    if (n) setTimeout(function () { if (!passing()) paint(); }, n + 20);
    // Tell the daemon which tab the agent is driving: it is need-human's default target. The
    // all-pages CLI form ({cli:true}) is not "driving" any one tab, so it stays silent.
    if (!(opts && opts.cli)) signal('driven');
    return { ok: true, state: PL.state, until: passUntil };
  };
  PL.info = function () {
    return {
      state: PL.state,
      reason: PL.reason,
      passing: passing(),
      banner: !!(ui.bar && !ui.bar.classList.contains('none')),
      stats: PL.stats,
      url: location.href,
    };
  };
  PL._destroy = function () {
    setLocal('pending');
    try { if (host) host.remove(); } catch (e) { /* already gone */ }
    clearInterval(timer);
    if (guard) guard.disconnect();
    for (var k = 0; k < POINTER.length; k += 1) window.removeEventListener(POINTER[k], onPointer, true);
    for (var j = 0; j < KEYS.length; j += 1) window.removeEventListener(KEYS[j], onKey, true);
    delete window.__pageLab;
  };

  // ---- survival ------------------------------------------------------------------------
  // Fail-open: no heartbeat for 15 s means the daemon is gone, so hand the page back.
  var timer = setInterval(function () {
    if (Date.now() - lastHb > 15000 && PL.state !== 'pending') setLocal('pending');
  }, 2000);
  // Hello: the daemon answers with the authoritative state (it lives in the stamp file, not
  // here, so it survives navigation). The binding can lag the first script by a tick.
  var tries = 0;
  (function hello() {
    if (!signal('hello') && (tries += 1) < 20) setTimeout(hello, 100);
  })();
})();
