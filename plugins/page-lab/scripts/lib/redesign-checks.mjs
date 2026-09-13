// The check groups a KEEP-LIST redesign is verified with, each opt-in.
//
// The shape these are written for is the one two sites converged on and the one
// `skills/site-redesign/keep-list.md` documents: keep the content grid, keep pagination,
// autohide the top bar, remove everything else, and leave every out-of-scope page alone.
// So the questions are: does the grid apply, does pagination survive, does the bar
// autohide, is everything else gone, is an out-of-scope page byte-identical to stock, do N
// document-start copies leave one of everything, and does teardown restore.
//
// Every group here was a hand-written probe first, on a real redesign, and earned its place
// by catching something. What is generalised is the SHAPE of the question, never the site's
// numbers: "the primary surface renders" is portable, "the card is 300px wide" is not — the
// latter is config, and a site that wants it says so in `cards.minCardWidth`.
//
// Design rules for anything added here:
//
//   1. A group whose config is missing SKIPS with a reason. It never fails, and it never
//      silently passes — a suite that scores 30/30 because 6 groups quietly did nothing is
//      the same lie as a suite that measured the wrong world [F-INJECT-IS-NOT-INSTALL].
//   2. Every failure carries the next thing to look at. "FAIL grid renders" is a ticket;
//      "FAIL grid renders — 0 of 24 children visible, grid attr is on: the elimination gate
//      matched everything" is a diagnosis.
//   3. Assert the property that carries the claim. `getComputedStyle().top` returns the USED
//      value and never `auto` [F-COMPUTED-TOP-IS-USED], so "grows upward" is proved by
//      bottom:0 plus a height under the container's, not by a keyword.
//
// Retired with the narrowing, and deliberately not kept as dead code: `drawer` (open by
// control, Escape, click-outside, focus trap, `inert`) and `actions` (a configured list of
// RELOCATED controls that must still act). Both existed to verify machinery the keep-list
// deletes rather than builds. Relocation survives as the exception — a site that really does
// move a control writes those assertions as a `.mjs` spec against userscript-acceptance.mjs,
// with `skills/site-redesign/relocation.md` for the traps.
//
// Not an entrypoint. Importer: redesign-acceptance.mjs.

import { assertRig, contrastAudit, freezeMotion, settle } from './harness.mjs';

const j = JSON.stringify;

/** Every selector the keep-list says stays. Used to define "everything else". */
function keeperSelectors(cfg) {
  const extra = cfg.purge?.keep;
  return [
    cfg.grid?.selector,
    cfg.pagination?.selector,
    cfg.topbar?.selector,
    ...(Array.isArray(extra) ? extra : extra ? [extra] : []),
  ].filter(Boolean);
}

/**
 * Count what renders and is NOT on the keep-list — "everything else is gone", as a number.
 *
 * A node is fine if it IS a keeper, is inside one, or is an ANCESTOR of one (a path node:
 * the keeper has to hang off something). Anything else that still paints is a stray. Only
 * the OUTERMOST node of a stray subtree is counted, so one surviving footer reports as 1
 * and not as its 80 descendants.
 */
export function strayExpr(cfg) {
  const keep = keeperSelectors(cfg);
  if (keep.length === 0) return null;
  const own = cfg.ownUiSelector ?? null;
  const ignore = cfg.purge?.ignore ?? null;
  const min = cfg.purge?.minArea ?? 8;
  return `(()=>{
    const keepers=[...document.querySelectorAll(${j(keep.join(','))})];
    const inside=new Set();const top=[];let count=0;
    for(const n of document.querySelectorAll('body *')){
      if(n.parentElement&&inside.has(n.parentElement)){inside.add(n);continue}
      ${own ? `if(n.closest(${j(own)}))continue;` : ''}
      ${ignore ? `if(n.closest(${j(ignore)}))continue;` : ''}
      if(keepers.some(k=>k===n||k.contains(n)||n.contains(k)))continue;
      const cs=getComputedStyle(n);
      if(cs.display==='none'||cs.visibility==='hidden'||cs.opacity==='0')continue;
      const r=n.getBoundingClientRect();
      if(r.width<${min}||r.height<${min})continue;
      inside.add(n);count++;
      if(top.length<6)top.push(n.tagName.toLowerCase()+(n.id?'#'+n.id:'')+
        (n.className&&typeof n.className==='string'?'.'+n.className.trim().split(/\\s+/)[0]:'')+
        ' '+Math.round(r.width)+'x'+Math.round(r.height));
    }
    return {count,top}})()`;
}

/**
 * Rendered direct children of the SURFACE CONTAINER that are not units.
 *
 * `strayExpr` cannot see these, and not by oversight: it skips anything a keeper contains,
 * which is right for the ancestors of the grid and wrong for its children. A grid
 * container's children are not all cards. Measured 2026-09-13: a block of marketing prose
 * laid out as a grid ITEM beside the cards, plus section headings and float clearers on
 * other shapes — 395px of headers on one page — survived FOUR successive leftover sweeps,
 * every one of which treated "inside the wall" as "is a card"
 * [F-INSIDE-THE-GRID-IS-NOT-A-CARD].
 *
 * A site whose grid legitimately carries non-unit children (a section heading the redesign
 * keeps) declares them in `grid.keepChildren`.
 */
export function gridStrayExpr(cfg) {
  const sel = cfg.grid?.selector;
  const card = cfg.grid?.card;
  if (!sel || !card) return null;
  const own = cfg.ownUiSelector ?? null;
  const keepKids = cfg.grid?.keepChildren ?? null;
  return `(()=>{
    const out=[];let count=0;
    for(const g of document.querySelectorAll(${j(sel)})){
      for(const k of g.children){
        if(k.matches(${j(card)}))continue;
        ${own ? `if(k.closest(${j(own)}))continue;` : ''}
        ${keepKids ? `if(k.matches(${j(keepKids)}))continue;` : ''}
        const cs=getComputedStyle(k);
        if(cs.display==='none'||cs.visibility==='hidden'||cs.opacity==='0')continue;
        const r=k.getBoundingClientRect();
        if(r.height<2||r.width<2)continue;
        count++;
        if(out.length<6)out.push((g.id?'#'+g.id:g.tagName.toLowerCase())+' > '+
          k.tagName.toLowerCase()+(k.id?'#'+k.id:'')+
          (k.className&&typeof k.className==='string'?'.'+k.className.trim().split(/\\s+/)[0]:'')+
          ' '+Math.round(r.width)+'x'+Math.round(r.height));
      }
    }
    return {count,top:out}})()`;
}

/** Markers that must be absent from a page the redesign is supposed to leave alone. */
export function identityExpr(cfg) {
  return `(()=>({
    adopted:document.adoptedStyleSheets.length,
    sheets:document.styleSheets.length,
    rootFlag:${cfg.rootFlag ? `document.documentElement.hasAttribute(${j(cfg.rootFlag)})` : 'false'},
    own:${cfg.ownUiSelector ? `document.querySelectorAll(${j(cfg.ownUiSelector)}).length` : '0'},
    teardown:${cfg.teardownGlobal ? `typeof window[${j(cfg.teardownGlobal)}]` : j('n/a')},
    htmlAttrs:[...document.documentElement.attributes].map(a=>a.name+'='+a.value).sort().join('|'),
    bodyBg:document.body?getComputedStyle(document.body).backgroundColor:null,
    bodyColor:document.body?getComputedStyle(document.body).color:null
  }))()`;
}

/** One page-side read that answers the diagnose line and feeds most of the groups. */
export function probeExpr(cfg) {
  const controls = Object.entries(cfg.controls ?? {})
    .map(([name, sel]) => `${j(name)}:document.querySelectorAll(${j(sel)}).length`)
    .join(',');
  const g = cfg.grid ?? {};
  const stray = cfg.purge ? strayExpr(cfg) : null;
  return `(()=>{
    const vis=e=>{const c=getComputedStyle(e);
      return c.display!=='none'&&c.visibility!=='hidden'&&e.getBoundingClientRect().height>2};
    const all=${g.selector ? `[...document.querySelectorAll(${j(g.selector)})]` : '[]'};
    const grid=all.find(e=>{const r=e.getBoundingClientRect();
      return r.width>0&&r.height>0&&getComputedStyle(e).display!=='none'})||all[0]||null;
    const kids=grid?[...grid.children]:[];
    const unitKids=${g.unitLink
      ? `kids.filter(k=>k.matches(${j(g.unitLink)})||!!k.querySelector(${j(g.unitLink)}))`
      : g.card ? `kids.filter(k=>k.matches(${j(g.card)})||!!k.querySelector(${j(g.card)}))` : 'kids'};
    const cards=${g.card ? `[...document.querySelectorAll(${j(g.card)})]` : '[]'};
    const gr=grid?grid.getBoundingClientRect():null;
    return {
      path:location.pathname,
      themed:${cfg.rootFlag ? `document.documentElement.hasAttribute(${j(cfg.rootFlag)})` : 'null'},
      teardownType:${cfg.teardownGlobal ? `typeof window[${j(cfg.teardownGlobal)}]` : j('n/a')},
      gridMatches:all.length,
      gridFound:grid!==null,
      gridOn:${g.appliedAttr ? `grid?grid.getAttribute(${j(g.appliedAttr)}):null` : 'null'},
      gridW:gr?Math.round(gr.width):0, gridH:gr?Math.round(gr.height):0,
      innerW:innerWidth, innerH:innerHeight,
      overflow:Math.max(0,document.documentElement.scrollWidth-innerWidth),
      units:kids.length, unitsVisible:kids.filter(vis).length,
      /* UNIT children only — children that carry a unit link, or match the card
         selector. The keep gate asks "did the elimination rule hide most of the
         GALLERY?", and answering it over ALL children penalises a build for hiding
         non-unit children, which is exactly what the purge group now requires
         [F-KEEP-GATE-COUNTED-NON-UNITS]. The whole-children count stays because the
         degradation group reads it to mean "the container still renders something",
         and a break that removes the href would make a unit-scoped count 0 and pass
         that check for the wrong reason. */
      unitKids:unitKids.length, unitKidsVisible:unitKids.filter(vis).length,
      cards:cards.length,
      aspects:cards.slice(0,3).map(c=>{const r=c.getBoundingClientRect();
        return r.height?+(r.width/r.height).toFixed(2):0}),
      cardW:cards.length?Math.round(cards[0].getBoundingClientRect().width):0,
      cardH:cards.length?Math.round(cards[0].getBoundingClientRect().height):0,
      gap:grid?getComputedStyle(grid).gap:null,
      promo:${g.promoAttr ? `document.querySelectorAll('['+${j(g.promoAttr)}+']').length` : '0'},
      organicLinks:${g.unitLink ? `grid?grid.querySelectorAll(${j(g.unitLink)}).length:0` : '0'},
      controls:{${controls}},
      adopted:document.adoptedStyleSheets.length,
      strays:${stray ? `(${stray}).count` : 'null'},
      bodyBg:document.body?getComputedStyle(document.body).backgroundColor:null
    }})()`;
}

/** applied | partial | stock | blank | no-surface — the one word a diagnose line leads with. */
export function classify(p) {
  if (p.themed === false) return 'stock';
  if (!p.gridFound) return 'no-surface';
  if (p.units > 0 && p.unitsVisible === 0) return 'blank';
  if (p.gridOn === null && p.themed) return 'partial';
  return 'applied';
}

/** The next thing to look at, for the shape this probe describes. Empty when nothing is off. */
export function hintFor(p, cfg) {
  const out = [];
  if (p.themed === false) {
    out.push(
      'root flag absent: either @match does not cover this shape, or the script threw at ' +
        'document-start (see the errors column)',
    );
  }
  if (!p.gridFound && cfg.grid?.selector) {
    out.push(`no element matched ${cfg.grid.selector} — this shape may not have the surface`);
  }
  // Several matches is NORMAL — a print or mobile duplicate inside a display:none parent is
  // common. It is only decision-relevant when the redesign also failed to land, which is the
  // signature of a host lookup that took the first MATCH rather than the first that RENDERS.
  if (p.gridMatches > 1 && (p.gridOn === null || p.unitsVisible === 0)) {
    out.push(
      `${p.gridMatches} elements match the surface selector and the redesign did not land on ` +
        "the rendered one — the script's host lookup must take the first that RENDERS",
    );
  }
  if (p.units > 0 && p.unitsVisible === 0) {
    out.push(
      'grid has children and none render: the hide-by-elimination gate matched everything — ' +
        'this is the blank-gallery defect, not a styling problem',
    );
  }
  // The gate that passes on ONE keeper and then hides the rest: the surface "renders", so
  // every present/visible check is green and 38 of 39 units are gone
  // [F-ELIMINATION-GATE-ONE-CARD].
  const ratio = cfg.purge?.minKeeperRatio ?? 0.5;
  if (p.units > 2 && p.unitsVisible > 0 && p.unitsVisible / p.units < ratio) {
    out.push(
      `only ${p.unitsVisible} of ${p.units} units render: the keep gate passed on a handful ` +
        'and the complement hid the rest — gate on a fraction of the container, not on >= 1',
    );
  }
  if (p.strays !== null && p.strays > (cfg.purge?.maxStrays ?? 0)) {
    out.push(`${p.strays} rendered block(s) are neither a keeper, a path to one, nor ours`);
  }
  if (p.overflow > 0) out.push(`${p.overflow}px of horizontal overflow on the document element`);
  if (p.gridW && p.innerW && p.gridW < p.innerW - 2) {
    out.push(`surface is ${p.innerW - p.gridW}px narrower than the viewport — not full-bleed`);
  }
  for (const [name, n] of Object.entries(p.controls ?? {})) {
    if (n === 0) out.push(`control "${name}" is absent`);
    if (n > 1) {
      out.push(
        `${n} copies of control "${name}": either two script copies are live (the installed ` +
          'one and this one) or teardown-at-entry did not fire',
      );
    }
  }
  return out;
}

/** URL shapes the redesign must NOT touch, normalised from the one-line config form. */
export function stockShapes(cfg) {
  return (cfg.stockShapes ?? []).map((s, i) => {
    const o = typeof s === 'string' ? { path: s } : s;
    return {
      label: o.label ?? o.path ?? `stock-${i + 1}`,
      url: o.url ?? (o.path ? cfg.origin.replace(/\/+$/, '') + o.path : null),
    };
  });
}

// ---------------------------------------------------------------------------------------
// Groups
//
// Signature: run(ctx) where ctx = { lab, cfg, shape, probe, t, note, source, script }.
//   t(name, pass, detail)  records an assertion, prefixed with the shape label by the runner
//   note(text)             records a non-assertion observation
//   script.detach/attach   remove / re-add the document-start registration (stock arms)
// `needs` lists config paths; a missing one skips the group with that path in the reason.
// `scope` is 'shape' (run per URL shape) or 'once' (run on the primary shape only).
// ---------------------------------------------------------------------------------------

export const GROUPS = {
  rig: {
    scope: 'once',
    needs: [],
    why: 'proves the input rig delivers trusted press/release before any null result is believed',
    async run({ lab, cfg, t }) {
      const r = await assertRig(lab, { selector: cfg.rig?.selector ?? 'a[href]' });
      t('input rig is alive', r.ok, r.why);
      if (!r.ok) t('REST OF SUITE IS SOUND', false, 'rig dead — every null below is unsound');
    },
  },

  surface: {
    scope: 'shape',
    needs: ['grid.selector'],
    why: 'the grid applies: the primary surface is present, renders its units, and carries our attribute',
    async run({ cfg, probe, t }) {
      const p = probe;
      t('primary surface present', p.gridFound, {
        matched: p.gridMatches,
        selector: cfg.grid.selector,
        next: p.gridFound ? undefined : 'selector rotted, or this shape has no surface',
      });
      if (!p.gridFound) return;
      t('surface renders units', p.unitsVisible > 0, {
        visible: p.unitsVisible,
        total: p.units,
        next:
          p.unitsVisible === 0
            ? 'children exist and none render — the elimination gate matched everything'
            : undefined,
      });
      if (cfg.grid.appliedAttr) {
        t('redesign applied to the surface', p.gridOn !== null, {
          attr: cfg.grid.appliedAttr,
          value: p.gridOn,
          next: p.gridOn === null ? 'the script found the page but not this container' : undefined,
        });
      }
      if (p.cards > 0 && p.aspects.length > 1) {
        const spread = Math.max(...p.aspects) - Math.min(...p.aspects);
        t('units share one aspect ratio', spread < 0.05, { aspects: p.aspects, spread });
      }
    },
  },

  fullbleed: {
    scope: 'shape',
    needs: ['grid.selector', 'widths'],
    why: 'full-bleed at every width, and zero horizontal overflow at every width',
    async run({ lab, cfg, t }) {
      const tol = cfg.fullbleedTolerance ?? 2;
      for (const w of cfg.widths) {
        await lab.setWidth(w);
        const p = await settle(() => lab.ev(probeExpr(cfg)), {
          tries: 20,
          gap: 150,
          stableFor: 2,
          accept: (v) => v.innerW === w,
        });
        t(`@${w} surface is full-bleed`, Math.abs(p.gridW - p.innerW) <= tol, {
          surface: p.gridW,
          viewport: p.innerW,
          next:
            p.gridW < p.innerW - tol
              ? 'a stock max-width or padding is still winning on an ancestor'
              : undefined,
        });
        t(`@${w} no horizontal overflow`, p.overflow === 0, {
          overflowPx: p.overflow,
          next: p.overflow ? 'something is wider than the viewport — find it before shipping' : undefined,
        });
      }
      await lab.clearWidth();
      // The override is sticky and shared with the operator's own DevTools
      // [F-STICKY-STATE]; leaving it set silently reshapes every later measurement.
      await settle(() => lab.ev('innerWidth'), { tries: 12, gap: 120, stableFor: 2 });
    },
  },

  purge: {
    scope: 'shape',
    needs: ['purge'],
    why: 'everything except the keep-list is gone — and the gate that hides it held',
    async run({ lab, cfg, probe, t }) {
      const max = cfg.purge.maxStrays ?? 0;
      const ratio = cfg.purge.minKeeperRatio ?? 0.5;

      // FIRST, because it is the failure that looks like success: a gate satisfied by ONE
      // keeper passes every "the surface renders" check while the complement hides the rest
      // — measured at 38 of 39 units gone [F-ELIMINATION-GATE-ONE-CARD].
      const total = probe.unitKids ?? probe.units;
      const shown = probe.unitKidsVisible ?? probe.unitsVisible;
      if (total > 2) {
        const kept = total === 0 ? 1 : shown / total;
        t(`keep gate kept at least ${Math.round(ratio * 100)}% of the units`, kept >= ratio, {
          visible: shown,
          total,
          allChildren: probe.units,
          kept: +kept.toFixed(3),
          next:
            kept < ratio
              ? 'the gate passed on a handful of keepers and the complement hid the rest. Gate ' +
                'on a fraction of the container\'s children, not on >= 1, and render stock below it'
              : undefined,
        });
      }

      // Counted, not checked off a list — because purging is LAYERED: removing the chrome
      // you can see exposes chrome you could not, and a suite that verified a list of
      // selectors would pass while the second layer is still on the page
      // [F-PURGE-IS-LAYERED].
      const expr = strayExpr(cfg);
      if (expr !== null) {
        const s = await lab.ev(expr);
        t('nothing outside the keep-list renders', s.count <= max, {
          strays: s.count,
          allowed: max,
          largest: s.top,
          next:
            s.count > max
              ? 'each of these is a rendered block that is neither a keeper, an ancestor of ' +
                'one, nor ours — the purge missed it, or it is a keeper you forgot to declare'
              : undefined,
        });
      }

      // The strays strayExpr STRUCTURALLY cannot see: children of the surface container
      // itself. It skips anything a keeper contains, which is right for the grid's ancestors
      // and wrong for its children [F-INSIDE-THE-GRID-IS-NOT-A-CARD].
      const gExpr = gridStrayExpr(cfg);
      if (gExpr !== null) {
        const gs = await lab.ev(gExpr);
        t('every rendered child of the surface is a unit', gs.count === 0, {
          strays: gs.count,
          largest: gs.top,
          next:
            gs.count > 0
              ? 'these are laid out as grid ITEMS beside the cards — headings, prose, float ' +
                'clearers. Hide non-unit children, GATED on the container actually holding a ' +
                'unit, so a renamed unit selector fails the gate rather than blanking the grid'
              : undefined,
        });
      }

      const gone = Array.isArray(cfg.purge.gone) ? cfg.purge.gone : [];
      if (gone.length) {
        // RENDERING matches, not DOM matches: the keep-list HIDES chrome rather than removing
        // it, so counting nodes would fail a working build.
        const n = await lab.ev(`[...document.querySelectorAll(${j(gone.join(','))})]
          .filter(e=>{const cs=getComputedStyle(e);
            return cs.display!=='none'&&cs.visibility!=='hidden'&&e.getBoundingClientRect().height>0}).length`);
        t('named chrome does not render', n === 0, { rendering: n, selectors: gone });
      }
    },
  },

  topbar: {
    scope: 'shape',
    needs: ['topbar.selector'],
    why: 'the bar autohides: hidden at rest, revealed by the pointer at the top edge AND by keyboard focus, never by scroll',
    async run({ lab, cfg, probe, t }) {
      const b = cfg.topbar;
      const sel = j(b.selector);
      const band = b.band ?? 6;
      const cx = Math.round((probe.innerW || 1280) / 2);
      const cy = Math.round((probe.innerH || 900) / 2);
      const park = () => lab.movePointer(cx, cy);
      const toEdge = () => lab.movePointer(cx, Math.max(1, Math.round(band / 2)));

      const read = () =>
        lab.ev(`(()=>{const e=document.querySelector(${sel});
          if(!e)return null;const cs=getComputedStyle(e);const r=e.getBoundingClientRect();
          return {shown:cs.display!=='none'&&cs.visibility!=='hidden'&&cs.opacity!=='0'
              &&r.height>2&&r.bottom>0,
            top:Math.round(r.top),h:Math.round(r.height),
            pe:cs.pointerEvents,display:cs.display,visibility:cs.visibility}})()`);

      const present = await read();
      t('top bar present in the DOM', present !== null, {
        next: present === null ? `nothing matched ${b.selector} on this shape` : undefined,
      });
      if (present === null) return;

      // 1. At rest. The pointer is parked at the CENTRE, not at (1,1): (1,1) is inside the
      //    reveal band, so parking there reads the revealed state as the rest state.
      await park();
      const rest = await settle(read, { tries: 20, gap: 120, stableFor: 3 });
      t('hidden at rest', rest?.shown === false, {
        ...rest,
        next: rest?.shown ? 'the bar never hides — it is spending the top band at rest' : undefined,
      });
      if (rest?.shown === false) {
        const atTop = await lab.ev(`(()=>{const e=document.elementFromPoint(${cx},1);
          return e?{tag:e.tagName,inBar:!!e.closest(${sel})}:null})()`);
        t('a hidden bar does not eat clicks at the top edge', atTop !== null && !atTop.inBar, {
          ...atTop,
          pointerEvents: rest?.pe,
          next: atTop?.inBar ? 'add `pointer-events: none` to the hidden state' : undefined,
        });
      }

      // 2. The pointer route.
      await toEdge();
      const shown = await settle(read, { tries: 25, gap: 120, stableFor: 2, accept: (v) => v?.shown });
      t(`revealed with the pointer within ${band}px of the top edge`, shown?.shown === true, {
        ...shown,
        next: shown?.shown ? undefined : 'the pointer route is dead — an off-canvas bar cannot ' +
          'be hovered, so the trigger must read the pointer position, not the bar\'s :hover',
      });

      // 3. And hides again — a bar that latches open is a bar that does not autohide.
      await park();
      const again = await settle(read, { tries: 25, gap: 120, stableFor: 2, accept: (v) => !v?.shown });
      t('hides again when the pointer leaves the band', again?.shown === false, again);

      // 4. The keyboard route, which is the one that has actually been dead
      //    [F-FOCUS-WITHIN-NOT-A-REVEAL]. Read whether focus LANDED first: a bar hidden with
      //    visibility/display is out of the tab order, so nothing inside can ever be focused
      //    and `:focus-within` can never match, however right the rule looks.
      //
      //    A TRUSTED Tab comes first, and it is not ceremony. A correct autohiding bar may
      //    gate its focus reveal on the reader having ACTED, because a site that autofocuses
      //    a control inside the bar produces focus at load with no user behind it — and a
      //    `:focus-within` rule then pins the bar open forever. That gate is opened by a real
      //    keydown, which `el.focus()` does not produce. Driving this check with a bare
      //    programmatic focus reported "keyboard path is dead" on a script whose keyboard path
      //    works for every actual Tab press [F-PROGRAMMATIC-FOCUS-IS-NOT-A-KEYBOARD-USER] —
      //    the suite's own "trusted events only" rule, broken inside the suite.
      if (b.focusable) {
        await lab.key('Tab');
        //    Try every match, and require the element to BECOME activeElement — not merely
        //    that activeElement is inside the bar. Both halves are load-bearing. A bar's
        //    first links are routinely ZERO-SIZE (icon toggles collapsed at desktop), and
        //    `el.focus()` on a zero-size element does not move focus; reading only
        //    `bar.contains(activeElement)` then reports whatever focus already was — which on
        //    a site that autofocuses its own search box is a trivial pass, and one element
        //    later a confident false failure [F-ZERO-SIZE-CONTROL-DOES-NOT-TAKE-FOCUS].
        const f = await lab.ev(`(()=>{const bar=document.querySelector(${sel});
          const els=[...document.querySelectorAll(${j(b.focusable)})];
          if(!bar||!els.length)return null;
          let tried=0;
          for(const el of els){tried++;el.focus();
            if(document.activeElement===el&&bar.contains(el))
              return {inBar:true,tried,active:el.tagName+(el.id?'#'+el.id:'')};}
          const a=document.activeElement;
          return {inBar:false,tried,active:a?a.tagName:null}})()`);
        t('a control inside the bar can take focus', f !== null && f.inBar, {
          ...f,
          next:
            f && !f.inBar
              ? 'focus never landed: the hidden state takes the subtree out of the tab order ' +
                '(visibility/display). Hide with `translate` instead [F-FOCUS-WITHIN-NOT-A-REVEAL]'
              : undefined,
        });
        const byFocus = await settle(read, { tries: 25, gap: 120, stableFor: 2, accept: (v) => v?.shown });
        t('revealed by keyboard focus', byFocus?.shown === true, {
          ...byFocus,
          next: byFocus?.shown ? undefined : 'pointer path works, keyboard path is dead even after ' +
            'a trusted Tab — drive the reveal from a `focusin` listener rather than assuming ' +
            '`:focus-within` fires',
        });
        await lab.ev('document.activeElement&&document.activeElement.blur();true');
        await park();
        await settle(read, { tries: 20, gap: 120, stableFor: 2, accept: (v) => !v?.shown });
      }

      // 5. NOT scroll-driven. Pointer parked away from the edge, scroll down, bar stays hidden.
      const to = b.scrollTo ?? 900;
      await lab.ev(`scrollTo(0,${to});true`);
      const scrolled = await settle(read, { tries: 20, gap: 120, stableFor: 3 });
      t('scrolling does not reveal it', scrolled?.shown === false, {
        ...scrolled,
        scrolledTo: to,
        next: scrolled?.shown
          ? 'a scroll-driven reveal fires on direction, not on intent — it appears while the ' +
            'reader is reading and hides while they hunt'
          : undefined,
      });
      await lab.ev('scrollTo(0,0);true');

      // 6. A transformed ancestor silently re-anchors a fixed descendant
      //    [F-TRANSFORM-CONTAINING-BLOCK] — caught structurally, before it presents as
      //    "position: fixed is not fixed".
      const anc = await lab.ev(`(()=>{const e=document.querySelector(${sel});if(!e)return null;
        const fixed=getComputedStyle(e).position==='fixed'||
          [...e.querySelectorAll('*')].slice(0,300).some(x=>getComputedStyle(x).position==='fixed');
        const bad=[];
        for(let n=e.parentElement;n&&n!==document.documentElement;n=n.parentElement){
          const c=getComputedStyle(n);
          if(c.transform!=='none'||c.filter!=='none'||c.perspective!=='none'||
             (c.backdropFilter&&c.backdropFilter!=='none')||/paint/.test(c.contain||''))
            bad.push(n.tagName.toLowerCase()+(n.id?'#'+n.id:''));}
        return {fixed,bad}})()`);
      t('no transformed ancestor above a fixed bar', !(anc?.fixed && anc.bad.length), {
        ...anc,
        next: anc?.fixed && anc.bad.length
          ? 'a transformed ancestor becomes the containing block for fixed descendants, so ' +
            'the bar rides it instead of the viewport [F-TRANSFORM-CONTAINING-BLOCK]'
          : undefined,
      });
      await park();
    },
  },

  'promo-gate': {
    scope: 'shape',
    needs: ['grid.selector'],
    why: 'the elimination gate holds on a shape with ZERO organic items — degrades to stock, never blank',
    async run({ shape, probe, t }) {
      if (shape.organic !== 0) {
        t('promo gate (shape not declared organic:0)', true, 'skipped — declare organic:0 to test it');
        return;
      }
      const p = probe;
      t('zero-organic shape is not blank', p.unitsVisible > 0 || p.units === 0, {
        visible: p.unitsVisible,
        total: p.units,
        next:
          p.units > 0 && p.unitsVisible === 0
            ? 'this is the failure mode the gate exists to prevent: it hid MORE as it matched ' +
              'LESS. Scope the rule so a failed match renders stock.'
            : undefined,
      });
    },
  },

  theme: {
    scope: 'shape',
    needs: ['theme'],
    why: 'zero light backgrounds and zero sub-AA text pairs, measured by WCAG, not eyeballed',
    async run({ lab, cfg, probe, t }) {
      // Stop time before reading colour: a frozen transition outranks author-!important
      // [F-ANIMATION-BEATS-IMPORTANT], so an unfrozen read measures the transition.
      await freezeMotion(lab.ev);
      const a = await contrastAudit(lab.ev, {
        exclude: cfg.ownUiSelector ?? null,
        minRatio: cfg.theme.minContrast ?? 4.5,
        lightness: cfg.theme.lightnessThreshold ?? 0.18,
        dark: cfg.theme.dark !== false,
      });
      if (cfg.rootFlag) {
        t('theme applied to this shape', probe.themed === true, {
          flag: cfg.rootFlag,
          next: probe.themed ? undefined : 'this shape is unthemed — a whole page shape was missed',
        });
      }
      if (cfg.theme.bodyBackground) {
        t('page ground is the palette ground', probe.bodyBg === cfg.theme.bodyBackground, {
          got: probe.bodyBg,
          want: cfg.theme.bodyBackground,
        });
      }
      t('no stock light backgrounds left', a.lightBg <= (cfg.theme.maxLightBackgrounds ?? 0), {
        lightBackgrounds: a.lightBg,
        checked: a.checked,
        next: a.lightBg ? 'a surface the remap never reached — find its rule, not its colour' : undefined,
      });
      t(
        `every text pair at or above ${cfg.theme.minContrast ?? 4.5}:1`,
        a.lowContrast <= (cfg.theme.maxLowContrast ?? 0),
        {
          belowTarget: a.lowContrast,
          checked: a.checked,
          worst: a.worst,
          next: a.lowContrast
            ? 'near-black ink on a new black ground is the usual cause — a hue-preserving ' +
              'channel scale cannot lift black [F-HUE-SCALE-CANNOT-LIFT-BLACK]. If the pair ' +
              'is one YOUR sheet painted, it is the sheet fighting the repaint ' +
              '[F-SHEET-VS-REPAINT-FIGHT], not a surface the theme missed'
            : undefined,
        },
      );
    },
  },

  controls: {
    scope: 'shape',
    needs: ['controls'],
    why: 'exactly one of each own-UI control — the double-copy detector',
    async run({ probe, t }) {
      for (const [name, n] of Object.entries(probe.controls)) {
        t(`exactly one "${name}"`, n === 1, {
          count: n,
          next:
            n > 1
              ? 'two live copies (the operator\'s install plus this injection) or a teardown-at-entry ' +
                'that did not fire — not necessarily a teardown bug'
              : n === 0
                ? 'the control never built: check for a page-side exception on this shape'
                : undefined,
        });
      }
    },
  },

  cards: {
    scope: 'shape',
    needs: ['grid.card', 'cards'],
    why: 'card geometry and the hover/title overlay, asserted on the property that carries the claim',
    async run({ lab, cfg, probe, t }) {
      const c = cfg.cards;
      if (probe.cards === 0) {
        t('cards present', false, { next: `nothing matched ${cfg.grid.card}` });
        return;
      }
      if (c.gap !== undefined) t('surface gap', probe.gap === c.gap, { got: probe.gap, want: c.gap });
      if (c.minCardWidth !== undefined) {
        t(`card at least ${c.minCardWidth}px wide`, probe.cardW >= c.minCardWidth, {
          got: `${probe.cardW}x${probe.cardH}`,
        });
      }
      if (Array.isArray(c.banned) && c.banned.length) {
        // RENDERING matches, not DOM matches: a redesign normally hides unit chrome rather
        // than removing it, and counting nodes would fail a working build.
        const n = await lab.ev(`[...document.querySelectorAll(${j(c.banned.join(','))})]
          .filter(e=>{const cs=getComputedStyle(e);
            return cs.display!=='none'&&cs.visibility!=='hidden'&&e.getBoundingClientRect().height>0}).length`);
        t('banned unit chrome does not render', n === 0, { rendering: n, selectors: c.banned });
      }
      if (c.overlay) {
        // The pointer is parked where the last trusted click left it, and on a full-bleed
        // wall the park point is ITSELF over a card — so read the rest state from a card
        // that is demonstrably neither hovered nor focused, or the hover state is measured
        // as the rest state. Ask the page which card that is: `elementFromPoint` is NOT a
        // substitute, because an autohiding bar reveals after the hit-test that set :hover
        // and the two then disagree [F-HOVER-STICKS-UNDER-REVEAL].
        await lab.parkPointer();
        const o = await settle(() => lab.ev(`(()=>{
          const all=[...document.querySelectorAll(${j(cfg.grid.card)})];
          const card=all.find(e=>!e.matches(':hover')&&!e.matches(':focus-within'))||all[0];
          if(!card)return null;const el=card.querySelector(${j(c.overlay.selector)});
          if(!el)return null;const cs=getComputedStyle(el);const cr=card.getBoundingClientRect();
          /* The clamp is read from the overlay OR a descendant. The common shape is a
             gradient WRAPPER that is the positioned, faded overlay with the text — and the
             clamp — in a child, so reading only the overlay node reports "none" on a build
             whose clamp works [F-CLAMP-LIVES-ON-THE-TEXT-NODE]. */
          let clamp=cs.webkitLineClamp;
          if(clamp==='none'){for(const k of el.querySelectorAll('*')){
            const kc=getComputedStyle(k).webkitLineClamp;
            if(kc&&kc!=='none'){clamp=kc;break}}}
          return {opacity:cs.opacity,bottom:cs.bottom,top:cs.top,clamp,
            h:Math.round(el.getBoundingClientRect().height),cardH:Math.round(cr.height)}})()`),
          { tries: 15, gap: 100, stableFor: 2, accept: (v) => v !== null });
        t('overlay present', o !== null, { next: `nothing matched ${c.overlay.selector} inside a card` });
        if (o) {
          if (c.overlay.hiddenAtRest) {
            t('overlay hidden at rest', o.opacity === '0', { opacity: o.opacity });
          }
          if (c.overlay.anchor === 'bottom') {
            // NOT `top === 'auto'`: computed top is the used value and never a keyword
            // [F-COMPUTED-TOP-IS-USED]. "Anchored at the bottom and growing upward" is
            // proved by bottom:0 plus a height under the card's.
            t('overlay anchored bottom, grows upward', o.bottom === '0px' && o.h > 0 && o.h < o.cardH, {
              bottom: o.bottom,
              overlayH: o.h,
              cardH: o.cardH,
            });
          }
          if (c.overlay.lineClamp !== undefined) {
            t(`overlay clamped to ${c.overlay.lineClamp} lines`, o.clamp === String(c.overlay.lineClamp), {
              got: o.clamp,
            });
          }
        }
      }
    },
  },

  pagination: {
    scope: 'shape',
    needs: ['pagination.selector'],
    why: 'pagination SURVIVES the purge: it renders where a shape has one, sits after the surface, and still navigates',
    async run({ lab, cfg, shape, t }) {
      const g = j(cfg.grid?.selector ?? 'body');
      const s = await lab.ev(`(()=>{const all=[...document.querySelectorAll(${g})];
        const grid=all.find(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0})||all[0];
        return [...document.querySelectorAll(${j(cfg.pagination.selector)})].map(p=>({
          visible:getComputedStyle(p).display!=='none'&&p.getBoundingClientRect().height>2,
          afterSurface:!!(grid&&(grid.compareDocumentPosition(p)&Node.DOCUMENT_POSITION_FOLLOWING)),
          inOwnUi:${cfg.ownUiSelector ? `!!p.closest(${j(cfg.ownUiSelector)})` : 'false'}}))})()`);
      const vis = s.filter((p) => p.visible);

      // A shape that ships no pagination at all is correct, not a failure — unless the config
      // says this shape has one, which is how "the purge ate the pager" gets caught.
      const required = cfg.pagination.requiredOn;
      const mustHave = required === true || (Array.isArray(required) && required.includes(shape.label));
      if (mustHave) {
        t('pagination survived the purge', vis.length >= 1, {
          rendering: vis.length,
          inDom: s.length,
          next:
            vis.length === 0
              ? s.length === 0
                ? 'the pager is not even in the DOM on this shape — selector rotted, or the ' +
                  'shape genuinely has one page'
                : 'the pager is in the DOM and hidden: the complement rule swallowed a KEEPER. ' +
                  'It is not on a marked path [F-KEEPER-INSIDE-CHROME]'
              : undefined,
        });
      }
      t('at most one pager renders', vis.length <= 1, { visible: vis.length, total: s.length });
      t(
        'any rendered pager is after the surface, outside our own UI',
        vis.every((v) => v.afterSurface && !v.inOwnUi),
        vis.length ? vis : 'none — this shape ships no pagination',
      );

      // Present, sized and hit-testable proves nothing [F-PRESENT-NOT-WORKING]: the pager is
      // the one control the keep-list keeps, so it is the one that gets exercised.
      if (cfg.pagination.next && vis.length) {
        const before = await lab.ev('location.href');
        /* MARK THE FIRST LINK THAT ACTUALLY LEAVES THIS PAGE. A pager's first
           anchor is routinely the CURRENT page - the "1" in "1 2 3 ..." - or a
           disabled "previous". Clicking it and asserting the URL changed is a
           false failure on a working pager, and it has now cost two diagnoses
           on two sites [F-PAGER-FIRST-LINK-IS-THIS-PAGE]. The mark is removed
           again below so nothing of ours outlives the check. */
        const picked = await lab.ev(`(()=>{
          for(const a of document.querySelectorAll(${j(cfg.pagination.next)})){
            let u; try{u=new URL(a.getAttribute('href')||'',location.href)}catch(e){continue}
            if(u.href===location.href)continue;
            const r=a.getBoundingClientRect(); if(r.width<4||r.height<4)continue;
            a.setAttribute('data-pl-next','');
            return (a.getAttribute('href')||'').slice(0,80);}
          return null})()`);
        const boxRect = await lab.clickStable(picked ? '[data-pl-next]' : cfg.pagination.next);
        if (boxRect === null) {
          t('pager "next" is present', false, {
            next: picked
              ? `matched ${picked} but it was not clickable`
              : `no link matching ${cfg.pagination.next} leaves this page — every candidate `
                + 'resolves to the current URL or has no box',
          });
        } else {
          if (boxRect.covered) {
            t('pager "next" is not covered', false, {
              at: boxRect,
              onTop: boxRect.covered,
              next: 'something is on top at the click point — a covered control is a real defect',
            });
          }
          const after = await settle(() => lab.ev('location.href'), {
            tries: 25,
            gap: 160,
            stableFor: 2,
            accept: (v) => v !== before,
          });
          t('pager "next" still navigates under a trusted click', after !== before, {
            before: String(before).slice(0, 90),
            after: String(after).slice(0, 90),
            next:
              after === before
                ? 'present, sized, hit-testable and inert — exactly the defect shape this ' +
                  'runner exists for [F-PRESENT-NOT-WORKING]. Confirm the rig passed first.'
                : undefined,
          });
          if (after !== before) await lab.navigate(shape.url ?? String(before));
          await lab.ev(`(()=>{const a=document.querySelector('[data-pl-next]');
            if(a)a.removeAttribute('data-pl-next');return 1})()`);
        }
      }
    },
  },

  'stock-identity': {
    scope: 'once',
    needs: ['stockShapes'],
    /** It visits OTHER shapes, so it labels its own assertions rather than borrowing one. */
    labelled: false,
    why: 'an out-of-scope page is byte-identical to a stock load — no sheet, no marker, no node of ours, same <html> attributes and body colours',
    async run({ lab, cfg, t, script }) {
      if (!script?.injected) {
        t('stock identity (nothing was injected)', true, 'skipped — this is a --stock run');
        return;
      }
      for (const shape of stockShapes(cfg)) {
        if (shape.url === null) {
          t(`[${shape.label}] stock shape is reachable`, false, 'no `path` or `url`');
          continue;
        }
        await lab.navigate(shape.url);
        const withScript = await settle(() => lab.ev(identityExpr(cfg)), {
          tries: cfg.settle?.tries ?? 30,
          gap: cfg.settle?.gap ?? 200,
          stableFor: 2,
        });

        // The absolute half: these are OUR markers, so the correct count is zero whatever
        // the site does.
        t(`[${shape.label}] out of scope: root flag absent`, withScript.rootFlag === false, {
          flag: cfg.rootFlag,
          next: withScript.rootFlag ? 'the script applied to a page it should not touch' : undefined,
        });
        t(`[${shape.label}] out of scope: zero nodes of ours`, withScript.own === 0, {
          own: withScript.own,
          selector: cfg.ownUiSelector,
        });

        // The comparative half: re-load the SAME url with the document-start registration
        // removed, and require the two reads to agree.
        let stock = null;
        try {
          await script.detach();
          await lab.navigate(shape.url);
          stock = await settle(() => lab.ev(identityExpr(cfg)), {
            tries: cfg.settle?.tries ?? 30,
            gap: cfg.settle?.gap ?? 200,
            stableFor: 2,
          });
        } finally {
          await script.attach();
        }
        t(
          `[${shape.label}] adoptedStyleSheets identical to a stock load`,
          withScript.adopted === stock.adopted,
          {
            scripted: withScript.adopted,
            stock: stock.adopted,
            next:
              withScript.adopted !== stock.adopted
                ? 'the theme sheet was adopted on a page the redesign does not own'
                : undefined,
          },
        );
        t(
          `[${shape.label}] <html> attributes identical to a stock load`,
          withScript.htmlAttrs === stock.htmlAttrs,
          { scripted: withScript.htmlAttrs, stock: stock.htmlAttrs },
        );
        t(
          `[${shape.label}] body colours identical to a stock load`,
          withScript.bodyBg === stock.bodyBg && withScript.bodyColor === stock.bodyColor,
          {
            scripted: [withScript.bodyBg, withScript.bodyColor],
            stock: [stock.bodyBg, stock.bodyColor],
            next:
              withScript.bodyBg === stock.bodyBg
                ? undefined
                : 'a theme reached a page that was declared out of scope — check the gate, not the palette',
          },
        );
      }
    },
  },

  lifecycle: {
    scope: 'once',
    needs: ['controls'],
    why: 'N document-start copies leave exactly one of everything — and the last copy still APPLIES',
    async run({ lab, cfg, shape, t, source, script }) {
      if (!script?.injected) {
        t('lifecycle (nothing was injected)', true, 'skipped — this is a --stock run');
        return;
      }
      // THREE copies, not two. If a bug's symptom is linear in copy count, a two-copy test
      // looks exactly like the bug it is meant to catch: 1 copy gave 1 control, 2 gave 2, 3
      // gave 3 [F-BOOT-LISTENER-SURVIVES-TEARDOWN]. And this is done by REGISTERING the body
      // again at document-start, not by eval-ing it into a loaded page — the copies must race
      // each other in the world the installed script runs in [F-INJECT-IS-NOT-INSTALL].
      const copies = cfg.copies ?? 3;
      const extra = [];
      try {
        for (let i = 1; i < copies; i += 1) extra.push(await lab.addDocStart(source));
        await lab.navigate(shape.url);
        const after = await settle(() => lab.ev(probeExpr(cfg)), { tries: 30, gap: 200, stableFor: 3 });
        for (const [name, n] of Object.entries(after.controls)) {
          t(`${copies} document-start copies leave exactly one "${name}"`, n === 1, {
            copies,
            count: n,
            next:
              n > 1
                ? 'a later copy did not stop the earlier one at entry. If the count RISES with ' +
                  'the copy count, the teardown returned before cancelling a pending bootstrap ' +
                  'listener [F-BOOT-LISTENER-SURVIVES-TEARDOWN]'
                : n === 0
                  ? 'no copy built the control at all — the copies deadlocked each other'
                  : undefined,
          });
        }
        t(`${copies} copies leave the surface rendering`, after.unitsVisible > 0 || after.units === 0, {
          visible: after.unitsVisible,
          total: after.units,
        });
        if (cfg.rootFlag) {
          // A re-run must still APPLY. A teardown contract traded for an "already init" flag
          // makes the last copy a silent no-op, which also produces exactly one of everything.
          t('the last copy still applied (a re-run is not a silent no-op)', after.themed === true, {
            flag: cfg.rootFlag,
            next: after.themed ? undefined : 'every copy tore the previous one down and none re-applied',
          });
        }
      } finally {
        for (const id of extra) await lab.removeDocStart(id);
      }
    },
  },

  teardown: {
    scope: 'once',
    needs: ['teardownGlobal'],
    why: 'teardown restores stock — own UI gone, root flag gone, the purged page back, nothing left adopted',
    async run({ lab, cfg, t }) {
      // `teardownFingerprint` is the RELOCATION case and is optional under the keep-list: a
      // redesign that moves nothing has nothing to put back, and teardown is "stop hiding".
      const fp = cfg.teardownFingerprint;
      const fingerprint = fp
        ? () => lab.ev(`(()=>{const e=document.querySelector(${j(fp.selector)});
            if(!e)return null;return {parent:e.parentElement?e.parentElement.tagName+'#'+
              (e.parentElement.id||'')+'.'+String(e.parentElement.className||'').split(' ')[0]:null,
              next:e.nextElementSibling?e.nextElementSibling.tagName:'(none)'}})()`)
        : null;
      const stock = fingerprint ? await fingerprint() : null;
      const before = await lab.ev(probeExpr(cfg));

      t('teardown global is a function', (await lab.ev(`typeof window[${j(cfg.teardownGlobal)}]`)) === 'function', {
        next: 'no teardown contract registered — a re-run cannot be made a no-op safely',
      });
      await lab.ev(`(()=>{const f=window[${j(cfg.teardownGlobal)}];
        if(typeof f==='function')f();return true})()`);
      const after = await settle(() => lab.ev(probeExpr(cfg)), { tries: 25, gap: 160, stableFor: 3 });

      if (cfg.rootFlag) t('root flag removed', after.themed === false, { flag: cfg.rootFlag });
      for (const [name, n] of Object.entries(after.controls)) {
        t(`own UI "${name}" removed`, n === 0, { remaining: n });
      }
      t('our stylesheet is no longer adopted', after.adopted < before.adopted || before.adopted === 0, {
        before: before.adopted,
        after: after.adopted,
        next:
          after.adopted >= before.adopted && before.adopted > 0
            ? 'the constructable sheet is still in document.adoptedStyleSheets — teardown ' +
              'removed the nodes but left the paint'
            : undefined,
      });
      t('stock surface renders after teardown', after.unitsVisible > 0 || after.units === 0, {
        visible: after.unitsVisible,
        total: after.units,
        next:
          after.units > 0 && after.unitsVisible === 0
            ? 'teardown left the page BLANK — worse than not running at all'
            : undefined,
      });
      if (after.strays !== null && before.strays !== null) {
        // The purge HIDES chrome; teardown has to stop hiding it, or the page is left
        // half-stripped with no script running to explain why.
        t('purged chrome comes back', after.strays >= before.strays, {
          strays: { before: before.strays, after: after.strays },
          next:
            after.strays < before.strays
              ? 'teardown left chrome hidden: it must revert the elimination rules, not just ' +
                'remove our own nodes'
              : undefined,
        });
      }
      if (fingerprint) {
        const back = await fingerprint();
        t('relocated node is back at its original parent and next sibling', JSON.stringify(back) === JSON.stringify(stock), {
          before: stock,
          after: back,
        });
      }
    },
  },

  degradation: {
    scope: 'once',
    needs: ['degrade.selector'],
    why: 'break the anchor by hand and assert the page renders STOCK, not mangled — the failure-mode test',
    async run({ lab, cfg, shape, t }) {
      const d = cfg.degrade;
      // Breaking it at document-start, BEFORE the script runs, is what makes this a real
      // rehearsal of a site rename: the script must find nothing, not find it and mangle it.
      // ADDING an attribute cannot break every anchor, and assuming it can produces a
      // degradation group that silently never runs. An anchor written as `[data-id]` matches
      // on PRESENCE, so setting it to "" leaves it matching; the honest break there is
      // removal. `removeAttr` is the other half of the mechanism, not an option
      // [F-A-BREAK-THAT-ADDS-CANNOT-BREAK-A-PRESENCE-TEST].
      const mutate = d.removeAttr
        ? `e.removeAttribute(${j(d.removeAttr)});`
        : `e.setAttribute(${j(d.breakAttr)},${j(d.breakValue ?? '')});`;
      const id = await lab.addDocStart(
        `document.addEventListener('readystatechange',function(){
           for(const e of document.querySelectorAll(${j(d.selector)})){
             ${mutate}}},true);`,
        { wrap: false },
      );
      await lab.navigate(shape.url);
      const p = await settle(() => lab.ev(probeExpr(cfg)), { tries: 30, gap: 200, stableFor: 3 });
      await lab.removeDocStart(id);
      t('a broken anchor degrades to stock, not blank', p.unitsVisible > 0 || p.units === 0, {
        visible: p.unitsVisible,
        total: p.units,
        next:
          p.units > 0 && p.unitsVisible === 0
            ? 'the page is MANGLED, not degraded: a rule that hides by elimination hid more as ' +
              'it matched less. Scope it so a failed match renders stock.'
            : undefined,
      });
      if (cfg.purge && p.strays !== null) {
        // Only meaningful if the break really did break the anchor. A break that the script
        // shrugs off makes every assertion below pass for the wrong reason, so say so instead.
        const broke = p.gridOn === null || p.themed === false;
        if (!broke) {
          t('the break actually broke the anchor', false, {
            gridOn: p.gridOn,
            themed: p.themed,
            next:
              'the script applied anyway, so degradation was NOT exercised — pick a break the ' +
              "script's anchor is actually sensitive to",
          });
        } else {
          // Degrading means REVERTING, not abstaining: a gate that declines to run leaves
          // whatever the last pass hid still hidden.
          t('a broken anchor leaves the chrome alone', p.strays > 0, {
            strays: p.strays,
            next:
              p.strays === 0
                ? 'nothing outside the keep-list renders even though the script did not apply: ' +
                  'the purge ran with no keeper found. Degrading to stock means REVERTING, not ' +
                  'abstaining'
                : undefined,
          });
        }
      }
      t('no own UI built against a surface that is not there', Object.values(p.controls).every((n) => n <= 1), p.controls);
    },
  },
};

/**
 * Shape groups that stay meaningful on a shape the redesign is SUPPOSED to decline
 * (`expect: 'stock'`). Everything else asserts that the redesign applied, and would turn a
 * correct refusal into a wall of failures.
 */
export const STOCK_SAFE_GROUPS = new Set(['promo-gate', 'pagination']);

/** Group names in the order a suite should run them — rig first, because it invalidates the rest. */
export const GROUP_ORDER = [
  'rig',
  'surface',
  'fullbleed',
  'purge',
  'promo-gate',
  'theme',
  'controls',
  'cards',
  'topbar',
  'pagination',
  'stock-identity',
  'lifecycle',
  'teardown',
  'degradation',
];

/** Does cfg carry every `needs` path? Returns the first missing path, or null. */
export function missingConfig(cfg, needs) {
  for (const path of needs) {
    let node = cfg;
    for (const part of path.split('.')) {
      node = node?.[part];
      if (node === undefined || node === null) return path;
    }
    if (Array.isArray(node) && node.length === 0) return path;
    if (typeof node === 'object' && !Array.isArray(node) && Object.keys(node).length === 0) return path;
  }
  return null;
}
