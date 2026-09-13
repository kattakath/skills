// The check groups a listing/gallery redesign is verified with, each opt-in.
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
// Not an entrypoint. Importer: redesign-acceptance.mjs.

import { assertRig, contrastAudit, freezeMotion, settle } from './harness.mjs';

/** One page-side read that answers the diagnose line and feeds most of the groups. */
export function probeExpr(cfg) {
  const j = JSON.stringify;
  const controls = Object.entries(cfg.controls ?? {})
    .map(([name, sel]) => `${j(name)}:document.querySelectorAll(${j(sel)}).length`)
    .join(',');
  const g = cfg.grid ?? {};
  return `(()=>{
    const vis=e=>{const c=getComputedStyle(e);
      return c.display!=='none'&&c.visibility!=='hidden'&&e.getBoundingClientRect().height>2};
    const all=${g.selector ? `[...document.querySelectorAll(${j(g.selector)})]` : '[]'};
    const grid=all.find(e=>{const r=e.getBoundingClientRect();
      return r.width>0&&r.height>0&&getComputedStyle(e).display!=='none'})||all[0]||null;
    const kids=grid?[...grid.children]:[];
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
      cards:cards.length,
      aspects:cards.slice(0,3).map(c=>{const r=c.getBoundingClientRect();
        return r.height?+(r.width/r.height).toFixed(2):0}),
      cardW:cards.length?Math.round(cards[0].getBoundingClientRect().width):0,
      cardH:cards.length?Math.round(cards[0].getBoundingClientRect().height):0,
      gap:grid?getComputedStyle(grid).gap:null,
      promo:${g.promoAttr ? `document.querySelectorAll('['+${j(g.promoAttr)}+']').length` : '0'},
      organicLinks:${g.unitLink ? `grid?grid.querySelectorAll(${j(g.unitLink)}).length:0` : '0'},
      controls:{${controls}},
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

// ---------------------------------------------------------------------------------------
// Groups
//
// Signature: run(ctx) where ctx = { lab, cfg, shape, probe, t, note }.
//   t(name, pass, detail)  records an assertion, prefixed with the shape label by the runner
//   note(text)             records a non-assertion observation
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
    why: 'the single most valuable check: the primary surface renders at all',
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
    async run({ lab, cfg, probe, t }) {
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
              'channel scale cannot lift black [F-HUE-SCALE-CANNOT-LIFT-BLACK]'
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
        const n = await lab.ev(`[...document.querySelectorAll(${JSON.stringify(c.banned.join(','))})]
          .filter(e=>{const cs=getComputedStyle(e);
            return cs.display!=='none'&&cs.visibility!=='hidden'&&e.getBoundingClientRect().height>0}).length`);
        t('banned unit chrome does not render', n === 0, { rendering: n, selectors: c.banned });
      }
      if (c.overlay) {
        // The pointer is parked where the last trusted click left it. A hover overlay read
        // with the pointer still on a card reports the HOVER state as the rest state.
        await lab.parkPointer();
        const o = await lab.ev(`(()=>{const card=document.querySelector(${JSON.stringify(cfg.grid.card)});
          if(!card)return null;const el=card.querySelector(${JSON.stringify(c.overlay.selector)});
          if(!el)return null;const cs=getComputedStyle(el);const cr=card.getBoundingClientRect();
          return {opacity:cs.opacity,bottom:cs.bottom,top:cs.top,clamp:cs.webkitLineClamp,
            h:Math.round(el.getBoundingClientRect().height),cardH:Math.round(cr.height)}})()`);
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
    needs: ['pagination'],
    why: 'at most one pager renders, and it sits after the surface rather than inside our own panel',
    async run({ lab, cfg, t }) {
      const g = JSON.stringify(cfg.grid.selector);
      const s = await lab.ev(`(()=>{const all=[...document.querySelectorAll(${g})];
        const grid=all.find(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0})||all[0];
        return [...document.querySelectorAll(${JSON.stringify(cfg.pagination.selector)})].map(p=>({
          visible:getComputedStyle(p).display!=='none'&&p.getBoundingClientRect().height>2,
          afterSurface:!!(grid&&(grid.compareDocumentPosition(p)&Node.DOCUMENT_POSITION_FOLLOWING)),
          inOwnUi:${cfg.ownUiSelector ? `!!p.closest(${JSON.stringify(cfg.ownUiSelector)})` : 'false'}}))})()`);
      const vis = s.filter((p) => p.visible);
      // A shape that ships no pagination at all is correct, not a failure.
      t('at most one pager renders', vis.length <= 1, { visible: vis.length, total: s.length });
      t(
        'any rendered pager is after the surface, outside our own UI',
        vis.every((v) => v.afterSurface && !v.inOwnUi),
        vis.length ? vis : 'none — this shape ships no pagination',
      );
    },
  },

  drawer: {
    scope: 'once',
    needs: ['drawer.control', 'drawer.panel'],
    why: 'opens by control, closes by Escape AND by trusted click-outside; focus trapped then restored; background inert',
    async run({ lab, cfg, t }) {
      const d = cfg.drawer;
      const openRead = () =>
        lab.ev(`(()=>{const p=document.querySelector(${JSON.stringify(d.panel)});
          if(!p)return null;const cs=getComputedStyle(p);const r=p.getBoundingClientRect();
          return {display:cs.display,visibility:cs.visibility,opacity:cs.opacity,
            hidden:p.getAttribute('aria-hidden'),x:Math.round(r.x),w:Math.round(r.width),
            onScreen:r.width>0&&r.height>0&&r.right>0&&r.x<innerWidth}})()`);
      const expandedRead = d.expandedOn
        ? () => lab.ev(`(()=>{const c=document.querySelector(${JSON.stringify(d.expandedOn)});
            return c?c.getAttribute('aria-expanded'):null})()`)
        : null;

      const closed0 = await settle(openRead, { stableFor: 3 });
      t('drawer starts closed', closed0 !== null && !closed0.onScreen, closed0);

      await lab.clickStable(d.control);
      const opened = await settle(openRead, { stableFor: 3, accept: (v) => v && v.onScreen });
      t('opens under a trusted click on its control', Boolean(opened?.onScreen), {
        ...opened,
        next: opened?.onScreen ? undefined : 'control rendered but did nothing — re-check the rig first',
      });
      if (expandedRead) t('aria-expanded tracks open', (await expandedRead()) === 'true', await expandedRead());

      if (d.focusFirst) {
        const f = await lab.ev(`(()=>{const a=document.activeElement;
          return {tag:a?a.tagName:null,inPanel:!!(a&&a.closest(${JSON.stringify(d.panel)}))}})()`);
        t('focus moved into the drawer', f.inPanel, f);
        // Tab from the last focusable must not escape the panel.
        for (let i = 0; i < (d.trapTabs ?? 12); i += 1) await lab.key('Tab');
        const after = await lab.ev(`!!(document.activeElement&&
          document.activeElement.closest(${JSON.stringify(d.panel)}))`);
        t(`focus still trapped after ${d.trapTabs ?? 12} Tabs`, after, {
          next: after ? undefined : 'a keyboard user can tab out of an open drawer into an inert page',
        });
      }
      if (d.inertTarget) {
        const inert = await lab.ev(`(()=>{const e=document.querySelector(${JSON.stringify(d.inertTarget)});
          return e?{inert:e.hasAttribute('inert')}:null})()`);
        t('background is inert while open', inert?.inert === true, inert);
      }

      await lab.key('Escape');
      const byEsc = await settle(openRead, { stableFor: 3, accept: (v) => v && !v.onScreen });
      t('closes on Escape', byEsc !== null && !byEsc.onScreen, byEsc);
      if (d.restoreFocus) {
        const back = await lab.ev(`!!(document.activeElement&&
          document.activeElement.matches(${JSON.stringify(d.control)}))`);
        t('focus restored to the control', back, {
          next: back ? undefined : 'focus was left on <body>: a screen-reader user loses their place',
        });
      }

      // Re-open so the click-outside assertion establishes its own precondition rather than
      // inheriting the Escape one — a dismissal check run against an already-closed drawer
      // passes for the wrong reason.
      await lab.clickStable(d.control);
      const reopened = await settle(openRead, { stableFor: 3, accept: (v) => v && v.onScreen });
      t('re-opens after Escape', Boolean(reopened?.onScreen), reopened);
      // Without this guard the click-outside check runs against an ALREADY-CLOSED drawer and
      // passes for the wrong reason — the ordering lie the acceptance notes warn about.
      if (!reopened?.onScreen) {
        t('closes on a TRUSTED click outside', false, {
          next: 'not measured: the drawer never re-opened, so this assertion had no precondition',
        });
        return;
      }
      const [ox, oy] = d.outsidePoint ?? [6, 6];
      const landed = await lab.ev(`(()=>{const e=document.elementFromPoint(${ox},${oy});
        return {tag:e?e.tagName:null,inPanel:!!(e&&e.closest(${JSON.stringify(d.panel)}))}})()`);
      t('click-outside point really is outside', landed.inPanel === false, {
        ...landed,
        next: landed.inPanel ? 'move drawer.outsidePoint — it lands inside the panel' : undefined,
      });
      await lab.click(ox, oy);
      const byOutside = await settle(openRead, { stableFor: 3, accept: (v) => v && !v.onScreen });
      t('closes on a TRUSTED click outside', byOutside !== null && !byOutside.onScreen, byOutside);
    },
  },

  actions: {
    scope: 'once',
    needs: ['actions'],
    why: 'each relocated control still PERFORMS its action under a trusted event — no sampling',
    async run({ lab, cfg, t }) {
      for (const a of cfg.actions) {
        // Open the container FIRST and let it finish moving: a control read the instant its
        // drawer starts sliding is clicked where it was, not where it is [F-TRANSITION-RACE].
        if (a.opens) {
          await lab.clickStable(a.opens);
          await settle(() => lab.renderedRect(a.selector), { tries: 25, gap: 120, stableFor: 2 });
        }
        const before = await lab.ev(
          a.expect === 'navigate'
            ? 'location.href'
            : `document.querySelectorAll(${JSON.stringify(a.observe ?? 'body *')}).length`,
        );
        const box = await lab.clickStable(a.selector);
        if (box === null) {
          t(`action "${a.name}" is present`, false, { next: `nothing matched ${a.selector}` });
          continue;
        }
        if (box.covered) {
          t(`action "${a.name}" is not covered`, false, {
            at: box,
            onTop: box.covered,
            next: 'something else is on top at the click point — a covered control is a real ' +
              'defect, and a different one from a dead control',
          });
        }
        const after = await settle(
          () =>
            lab.ev(
              a.expect === 'navigate'
                ? 'location.href'
                : `document.querySelectorAll(${JSON.stringify(a.observe ?? 'body *')}).length`,
            ),
          { tries: a.tries ?? 25, gap: 160, stableFor: 2, accept: (v) => v !== before },
        );
        t(`action "${a.name}" still performs`, after !== before, {
          expect: a.expect ?? 'change',
          before: String(before).slice(0, 90),
          after: String(after).slice(0, 90),
          next:
            after === before
              ? 'present, sized, hit-testable and inert — exactly the shape of the defect this ' +
                'runner exists for [F-PRESENT-NOT-WORKING]. Confirm the rig passed first.'
              : undefined,
        });
        if (a.expect === 'navigate' && after !== before && a.back !== false) {
          await lab.navigate(String(before));
        }
      }
    },
  },

  lifecycle: {
    scope: 'once',
    needs: ['controls'],
    why: 'a SECOND copy injected into a live document does not double the UI — the livelock test',
    async run({ lab, cfg, t, source }) {
      const before = await lab.ev(probeExpr(cfg));
      await lab.ev(`(0,eval)(${JSON.stringify(source)}); true`);
      const after = await settle(() => lab.ev(probeExpr(cfg)), { tries: 25, gap: 160, stableFor: 3 });
      for (const [name, n] of Object.entries(after.controls)) {
        t(`double-inject leaves exactly one "${name}"`, n === 1, {
          before: before.controls[name],
          after: n,
          next:
            n > 1
              ? 'the second run did not call the previous teardown at entry — two copies now ' +
                'fight over the same nodes'
              : undefined,
        });
      }
      t('double-inject leaves the surface rendering', after.unitsVisible > 0 || after.units === 0, {
        visible: after.unitsVisible,
        total: after.units,
      });
    },
  },

  teardown: {
    scope: 'once',
    needs: ['teardownGlobal'],
    why: 'teardown restores stock — own UI gone, relocated nodes back at parent AND next sibling',
    async run({ lab, cfg, t }) {
      const fp = cfg.teardownFingerprint;
      const fingerprint = fp
        ? () => lab.ev(`(()=>{const e=document.querySelector(${JSON.stringify(fp.selector)});
            if(!e)return null;return {parent:e.parentElement?e.parentElement.tagName+'#'+
              (e.parentElement.id||'')+'.'+String(e.parentElement.className||'').split(' ')[0]:null,
              next:e.nextElementSibling?e.nextElementSibling.tagName:'(none)'}})()`)
        : null;
      const stock = fingerprint ? await fingerprint() : null;

      t('teardown global is a function', (await lab.ev(`typeof window[${JSON.stringify(cfg.teardownGlobal)}]`)) === 'function', {
        next: 'no teardown contract registered — a re-run cannot be made a no-op safely',
      });
      await lab.ev(`(()=>{const f=window[${JSON.stringify(cfg.teardownGlobal)}];
        if(typeof f==='function')f();return true})()`);
      const after = await settle(() => lab.ev(probeExpr(cfg)), { tries: 25, gap: 160, stableFor: 3 });

      if (cfg.rootFlag) t('root flag removed', after.themed === false, { flag: cfg.rootFlag });
      for (const [name, n] of Object.entries(after.controls)) {
        t(`own UI "${name}" removed`, n === 0, { remaining: n });
      }
      t('stock surface renders after teardown', after.unitsVisible > 0 || after.units === 0, {
        visible: after.unitsVisible,
        total: after.units,
        next:
          after.units > 0 && after.unitsVisible === 0
            ? 'teardown left the page BLANK — worse than not running at all'
            : undefined,
      });
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
    needs: ['degrade.breakAttr', 'degrade.breakValue'],
    why: 'break the anchor by hand and assert the page renders STOCK, not mangled — the failure-mode test',
    async run({ lab, cfg, shape, t }) {
      const d = cfg.degrade;
      // Breaking it at document-start, BEFORE the script runs, is what makes this a real
      // rehearsal of a site rename: the script must find nothing, not find it and mangle it.
      const id = await lab.addDocStart(
        `document.addEventListener('readystatechange',function(){
           for(const e of document.querySelectorAll(${JSON.stringify(d.selector)})){
             e.setAttribute(${JSON.stringify(d.breakAttr)},${JSON.stringify(d.breakValue)});}},true);`,
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
      t('no own UI built against a surface that is not there', Object.values(p.controls).every((n) => n <= 1), p.controls);
    },
  },
};

/** Group names in the order a suite should run them — rig first, because it invalidates the rest. */
export const GROUP_ORDER = [
  'rig',
  'surface',
  'fullbleed',
  'promo-gate',
  'theme',
  'controls',
  'cards',
  'pagination',
  'drawer',
  'actions',
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
