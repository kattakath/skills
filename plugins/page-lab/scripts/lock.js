() => {
  // page-lab lock: paste this whole function as evaluate_script's `function`. Idempotent.
  const W = window;
  if (W.__pageLock) return W.__pageLock.state;
  const L = (W.__pageLock = { state: 'locked' });
  let until = 0, keys = [], host, layer, pill;
  const open = () => Date.now() < until;
  const stop = (e) => (e.preventDefault(), e.stopImmediatePropagation());
  const POINTER = ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'pointerdown', 'pointerup', 'auxclick', 'touchstart', 'touchend'];
  const KEYS = ['keydown', 'keyup', 'keypress', 'beforeinput', 'textInput'];
  const onPointer = (e) => {
    if (open()) return;
    if (e.type === 'click' && pill) {
      const r = pill.getBoundingClientRect(); // closed shadow root: hit-test the label by rect
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) release();
    }
    stop(e);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !(open() && keys.includes('Escape'))) {
      if (e.type === 'keydown') release();
      return stop(e);
    }
    if (!open()) stop(e);
  };
  const onWheel = (e) => open() || stop(e);
  const detach = () => {
    POINTER.forEach((t) => W.removeEventListener(t, onPointer, true));
    KEYS.forEach((t) => W.removeEventListener(t, onKey, true));
    W.removeEventListener('wheel', onWheel, true);
    if (host) host.remove();
  };
  // Esc / label click: the lock is gone at once and stays gone until the agent calls unlock() then lock().
  const release = () => {
    detach();
    L.state = 'released';
    L.pass = () => ({ ok: false, state: 'released' });
  };
  L.pass = (ms = 5000, o = {}) => {
    until = Date.now() + Math.min(Math.max(ms, 100), 30000);
    keys = o.keys || [];
    if (layer) layer.style.pointerEvents = 'none';
    setTimeout(() => open() || !layer || (layer.style.pointerEvents = 'auto'), until - Date.now() + 20);
    return { ok: true, state: L.state };
  };
  L.unlock = () => (detach(), delete W.__pageLock, 'unlocked');
  POINTER.forEach((t) => W.addEventListener(t, onPointer, { capture: true, passive: false }));
  KEYS.forEach((t) => W.addEventListener(t, onKey, { capture: true, passive: false }));
  W.addEventListener('wheel', onWheel, { capture: true, passive: false });
  const mount = () => {
    if (L.state !== 'locked') return;
    host = document.createElement('div');
    host.setAttribute('style', 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important');
    const sh = host.attachShadow({ mode: 'closed' });
    const css = document.createElement('style');
    css.textContent = '.l{position:fixed;inset:0;background:rgba(56,120,255,.12);cursor:not-allowed;pointer-events:auto}' +
      '.p{position:fixed;top:6px;left:50%;transform:translateX(-50%);background:rgba(20,40,110,.92);color:#fff;' +
      'font:13px/1.3 system-ui,sans-serif;padding:5px 14px;border-radius:999px;cursor:pointer}';
    layer = document.createElement('div');
    layer.className = 'l';
    pill = document.createElement('div');
    pill.className = 'p';
    pill.textContent = 'Claude is driving — press Esc to take over';
    layer.append(pill);
    sh.append(css, layer);
    document.documentElement.appendChild(host);
  };
  if (document.documentElement) mount();
  else new MutationObserver((_, ob) => document.documentElement && (ob.disconnect(), mount())).observe(document, { childList: true });
  return L.state;
}
