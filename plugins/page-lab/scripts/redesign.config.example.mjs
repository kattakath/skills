// A worked config for redesign-acceptance.mjs — the KEEP-LIST redesign.
//
// The shape it describes is the default one (`skills/site-redesign/keep-list.md`): a site
// whose pages are a grid of units under some chrome, redesigned into a full-bleed wall that
// KEEPS the grid, KEEPS pagination, AUTOHIDES the top bar and REMOVES everything else — and
// leaves every page that is not that surface completely alone, theme included.
//
// It is deliberately short. The drawer block, the relocated-control action list and the
// stranded-link harvesting that earlier versions of this file carried are gone with the
// machinery they verified; a site that really does relocate a control writes those few
// assertions as a `.mjs` spec against userscript-acceptance.mjs instead.
//
// Copy this file next to your `.user.js`, fill it in from the survey, and run:
//
//   node redesign-acceptance.mjs --diagnose ./my-site.redesign.mjs   # facts, no verdicts
//   node redesign-acceptance.mjs           ./my-site.redesign.mjs   # the suite
//
// Every selector here must be an ARIA role, an `href` shape, a data attribute or a site
// class you have verified on the live page with selector-verify.mjs. A generated framework
// class is not an anchor; the verifier's GENERATED verdict exists to say so.

export default {
  /** Label for the report header. Not a selector. */
  name: 'gallery wall',

  /** The `.user.js` under test, relative to THIS file. */
  script: '../my-site.user.js',

  /** Scheme + host. Shapes below are joined onto it. */
  origin: 'https://example.com',

  // -------------------------------------------------------------------------------------
  // URL shapes the redesign OWNS. One REAL navigation each — not one eval into a settled
  // page [F-INJECT-IS-NOT-INSTALL]. Include every structurally different page the surface
  // appears on: the one that renders differently is the one that ships broken.
  // -------------------------------------------------------------------------------------
  shapes: [
    { label: 'home', path: '/' },
    { label: 'search', path: '/search/example' },
    { label: 'listing', path: '/category/example' },
    // A shape with ZERO organic units is the one that proves the elimination gate degrades
    // to stock instead of hiding everything. Find one; do not assume you have none.
    { label: 'promo-only', path: '/sponsored', organic: 0 },
  ],

  // -------------------------------------------------------------------------------------
  // URL shapes the redesign must NOT touch — the headline check, and one line to fill in.
  // Each is loaded twice, with and without the script, and required to come back identical:
  // nothing of ours adopted, no marker, no node of ours, the same <html> attributes and the
  // same body colours. "Other pages get nothing, not even a theme" is a claim, so prove it.
  // -------------------------------------------------------------------------------------
  stockShapes: ['/video/example', '/profile/example'],

  // -------------------------------------------------------------------------------------
  // What the redesign owns
  // -------------------------------------------------------------------------------------
  /** Class prefix on every node WE create. Becomes the theme audit's exclusion list. */
  ownUiPrefix: 'xx-redesign',
  /** The teardown contract global the authoring skill requires. */
  teardownGlobal: '__nixExampleTeardown',
  /** Attribute the script stamps on <html> when it has applied. The "did it run here?" flag. */
  rootFlag: 'data-xx-redesign',

  // -------------------------------------------------------------------------------------
  // KEEPER 1 — the primary surface
  // -------------------------------------------------------------------------------------
  grid: {
    /** The SITE's own container. Verify UNIQUE, and expect more than one match on some shapes. */
    selector: '.listing-grid',
    /** Attribute the script stamps on the container it actually took over. */
    appliedAttr: 'data-xx-grid',
    /** OUR card wrapper, or the site's unit if the redesign does not wrap. */
    card: '[data-xx-card]',
    /** An organic unit's link shape — an `href` pattern, never a class. */
    unitLink: 'a[href*="/item-"]',
    /**
     * Non-unit children of the container the redesign KEEPS, if any. Everything else that
     * renders as a direct child of the grid is a stray: a grid container's children are not
     * all cards, and a sweep that treats "inside the wall" as "is a card" cannot see them —
     * measured at 395px of section headers surviving four sweeps
     * [F-INSIDE-THE-GRID-IS-NOT-A-CARD].
     */
    // keepChildren: '.section-heading',
    /** Attribute the script stamps on units it eliminated as promoted. */
    promoAttr: 'data-xx-promo',
  },

  // -------------------------------------------------------------------------------------
  // KEEPER 2 — pagination. `requiredOn` is how "the purge ate the pager" gets caught:
  // without it, a shape that renders no pager passes, because a shape with one page should.
  // -------------------------------------------------------------------------------------
  pagination: {
    selector: '.pagination',
    next: '.pagination a[href*="?p="]',
    requiredOn: ['home', 'listing'],
  },

  // -------------------------------------------------------------------------------------
  // KEEPER 3 — the autohiding bar (skills/site-redesign/topbar.md). `band` must be the SAME
  // number the script uses; `focusable` is what proves the keyboard route, which is the one
  // that has actually shipped dead [F-FOCUS-WITHIN-NOT-A-REVEAL].
  // -------------------------------------------------------------------------------------
  topbar: {
    selector: '[data-xx-topbar]',
    band: 6,
    /**
     * Can be broad: the check walks every match until one genuinely BECOMES
     * `document.activeElement`. A bar's first controls are routinely zero-size icon toggles
     * that `el.focus()` cannot move focus to [F-ZERO-SIZE-CONTROL-DOES-NOT-TAKE-FOCUS], and
     * the check presses a trusted Tab first, because a correct bar may gate its focus reveal
     * on the reader having acted [F-PROGRAMMATIC-FOCUS-IS-NOT-A-KEYBOARD-USER].
     */
    focusable: '[data-xx-topbar] input, [data-xx-topbar] a[href]',
    // scrollTo: 900,   // how far to scroll when proving the reveal is NOT scroll-driven
  },

  // -------------------------------------------------------------------------------------
  // EVERYTHING ELSE — asserted as a count of what still renders outside the keepers, rather
  // than as a list of containers that will rot. `minKeeperRatio` is the gate check: a gate
  // satisfied by ONE keeper passes every "the surface renders" assertion while the
  // complement hides the rest — measured at 38 of 39 units gone
  // [F-ELIMINATION-GATE-ONE-CARD].
  // -------------------------------------------------------------------------------------
  purge: {
    maxStrays: 0,
    minKeeperRatio: 0.5,
    /** Extra keepers beyond grid + pagination + topbar, if the survey found any. */
    // keep: ['[role="alert"]'],
    /** Subtrees to ignore entirely — a consent frame the site owns, say. */
    // ignore: '#cmp-container',
    /** Optional named chrome that must render zero pixels. Belt and braces. */
    gone: ['[role="contentinfo"]', '[role="complementary"]'],
  },

  /** Own-UI singletons. Each must resolve to EXACTLY one node — the double-copy detector. */
  controls: {
    topbar: '[data-xx-topbar]',
  },

  /**
   * Viewport widths for the full-bleed / overflow sweep. DESKTOP ONLY — a userscript manager
   * runs in a desktop browser, so 1280 is the floor, not a small case to defend
   * (SKILL.md § Desktop only).
   */
  widths: [1280, 1512, 1920, 2560],

  // -------------------------------------------------------------------------------------
  // The rig probe. An ON-SCREEN stock control whose click is observable.
  // An off-canvas link here produces a false "rig dead", which is the same lie inverted.
  // -------------------------------------------------------------------------------------
  rig: { selector: 'a[href]' },

  // -------------------------------------------------------------------------------------
  // Theme. Thresholds, not colours: key the verdict on the measured ratio
  // [F-CONTRAST-RATIO-ONLY].
  // -------------------------------------------------------------------------------------
  theme: {
    dark: true,
    minContrast: 4.5,
    maxLowContrast: 0,
    maxLightBackgrounds: 0,
    lightnessThreshold: 0.18,
    // bodyBackground: 'rgb(0, 0, 0)',   // optional: assert the exact ground
  },

  /** Card geometry and the hover/title overlay. Omit the whole block to skip the group. */
  cards: {
    gap: '1px',
    minCardWidth: 300,
    /** Unit chrome the redesign removes. Zero RENDERING matches is the assertion. */
    banned: ['[class*="xx-redesign-badge"]', '[class*="xx-redesign-views"]'],
    overlay: {
      /**
       * The node that is POSITIONED and FADED — usually a gradient wrapper, not the text.
       * The clamp is read from this node or its first clamped descendant, so the text may
       * sit inside and carry `opacity: 1` of its own [F-CLAMP-LIVES-ON-THE-TEXT-NODE].
       */
      selector: '.xx-redesign-title',
      hiddenAtRest: true,
      /** 'bottom' asserts bottom:0 AND a height under the card's — never `top === "auto"`,
       *  which computed style can never return [F-COMPUTED-TOP-IS-USED]. */
      anchor: 'bottom',
      lineClamp: 2,
    },
  },

  /**
   * How many document-start copies the lifecycle group races against each other. THREE, not
   * two: if a bug's symptom is linear in copy count, a two-copy test looks exactly like the
   * bug [F-BOOT-LISTENER-SURVIVES-TEARDOWN].
   */
  copies: 3,

  /**
   * Only for a redesign that actually MOVES a node — the exception, not the path
   * (skills/site-redesign/relocation.md). Teardown must put it back at its original parent
   * AND next sibling. A keep-list redesign moves nothing and omits this.
   */
  // teardownFingerprint: { selector: '.pagination' },

  // -------------------------------------------------------------------------------------
  // Degradation: break the anchor at document-start, BEFORE the script runs, and assert the
  // page renders STOCK rather than mangled. This is the test that proves the failure mode —
  // so pick a break the script's anchor is genuinely sensitive to, or the group says the
  // break did not break anything rather than passing for the wrong reason.
  // -------------------------------------------------------------------------------------
  degrade: {
    selector: '.listing-grid',
    breakAttr: 'data-xx-broken-on-purpose',
    breakValue: '1',
    /**
     * Use `removeAttr` INSTEAD of breakAttr/breakValue when the anchor is a presence test.
     * `[data-id]` matches whether or not the value is empty, so setting it breaks nothing and
     * the whole group passes without having tested anything
     * [F-A-BREAK-THAT-ADDS-CANNOT-BREAK-A-PRESENCE-TEST].
     */
    // removeAttr: 'data-id',
  },

  /** How long a shape may take to stop changing. Polling, never a fixed sleep. */
  settle: { tries: 30, gap: 200, stableFor: 3 },

  /** Which groups run. Drop one to skip it; a group whose config is absent skips loudly. */
  groups: [
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
  ],
};
