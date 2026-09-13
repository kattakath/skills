// A worked config for redesign-acceptance.mjs — a LISTING/GALLERY redesign.
//
// The shape it describes: a site whose pages are a grid of units (cards, thumbnails, ads,
// listings) under some chrome, redesigned into a full-bleed wall with the site's own
// controls relocated into a drawer. That is the most common redesign shape, and everything
// below is the SHAPE of the question — the values are yours to measure.
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
  name: 'listing-grid redesign',

  /** The `.user.js` under test, relative to THIS file. */
  script: '../my-site.user.js',

  /** Scheme + host. Shapes below are joined onto it. */
  origin: 'https://example.com',

  // -------------------------------------------------------------------------------------
  // URL shapes. One REAL navigation each — not one eval into a settled page
  // [F-INJECT-IS-NOT-INSTALL]. Include every structurally different page the @match covers:
  // the one that renders differently is the one that ships broken.
  // -------------------------------------------------------------------------------------
  shapes: [
    { label: 'home', path: '/' },
    { label: 'search', path: '/search/example' },
    { label: 'listing', path: '/category/example' },
    // A shape with ZERO organic units is the one that proves the elimination gate degrades
    // to stock instead of hiding everything. Find one; do not assume you have none.
    { label: 'promo-only', path: '/sponsored', organic: 0 },
    // A shape reached by FOLLOWING a link, not by a known path. Hard-coding one detail URL
    // makes the config rot on the site's next content rotation.
    { label: 'detail', discover: { from: '/search/example', linkSelector: 'a[href*="/item-"]' } },
  ],

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
  // The primary surface
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
    /** Attribute the script stamps on units it eliminated as promoted. */
    promoAttr: 'data-xx-promo',
  },

  /** Own-UI singletons. Each must resolve to EXACTLY one node — the double-copy detector. */
  controls: {
    launcher: '.xx-redesign-fab',
    drawer: '.xx-redesign-panel',
  },

  /** Viewport widths for the full-bleed / overflow sweep. Include the narrowest you support. */
  widths: [390, 768, 1512, 2560],

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
    /** Unit chrome the redesign removes. Zero matches is the assertion. */
    banned: ['[class*="xx-redesign-badge"]', '[class*="xx-redesign-views"]'],
    overlay: {
      selector: '.xx-redesign-title',
      hiddenAtRest: true,
      /** 'bottom' asserts bottom:0 AND a height under the card's — never `top === "auto"`,
       *  which computed style can never return [F-COMPUTED-TOP-IS-USED]. */
      anchor: 'bottom',
      lineClamp: 2,
    },
  },

  /** The site's pager, wherever the redesign put it. */
  pagination: { selector: '.pagination' },

  // -------------------------------------------------------------------------------------
  // The drawer / panel
  // -------------------------------------------------------------------------------------
  drawer: {
    control: '.xx-redesign-fab',
    panel: '.xx-redesign-panel',
    expandedOn: '.xx-redesign-fab',
    focusFirst: true,
    trapTabs: 12,
    restoreFocus: true,
    inertTarget: 'main',
    /** Where a trusted click-outside lands. The runner asserts this point really is outside. */
    outsidePoint: [6, 6],
  },

  // -------------------------------------------------------------------------------------
  // Relocated controls that must still ACT. One entry per control — there is no sampling
  // here, because "present, sized, hit-testable and inert" is exactly the defect shape
  // [F-PRESENT-NOT-WORKING].
  // -------------------------------------------------------------------------------------
  actions: [
    {
      name: 'pagination next',
      selector: '.pagination a[href*="?p="]',
      expect: 'navigate',
    },
    {
      name: 'filter inside the drawer',
      opens: '.xx-redesign-fab', // click this first to reach the control
      selector: '.xx-redesign-panel [role="button"]',
      expect: 'change',
      observe: '[data-xx-card]', // what changing proves the filter filtered
    },
  ],

  /** Teardown must put a relocated node back at its original parent AND next sibling. */
  teardownFingerprint: { selector: '.pagination' },

  // -------------------------------------------------------------------------------------
  // Degradation: break the anchor at document-start, BEFORE the script runs, and assert the
  // page renders STOCK rather than mangled. This is the test that proves the failure mode.
  // -------------------------------------------------------------------------------------
  degrade: {
    selector: '.listing-grid',
    breakAttr: 'data-xx-broken-on-purpose',
    breakValue: '1',
  },

  /** How long a shape may take to stop changing. Polling, never a fixed sleep. */
  settle: { tries: 30, gap: 200, stableFor: 3 },

  /** Which groups run. Drop one to skip it; a group whose config is absent skips loudly. */
  groups: [
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
  ],
};
