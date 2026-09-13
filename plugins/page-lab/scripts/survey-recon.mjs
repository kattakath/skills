#!/usr/bin/env node
// M1–M4 and M10–M12 of the site-redesign survey, measured rather than eyeballed.
//
// Why this exists: acceptance had a 14-group runner and the SURVEY had prose. So every new
// site hand-rolled its recon, and the hand-rolled version got the primary container wrong on
// the second URL shape it looked at — it ranked a promotional strip above the real grid,
// which is the first trap `keep-list.md` warns about. Prose cannot enforce a ranking; a
// script can [F-SURVEY-HAD-NO-TOOL].
//
// What it will NOT do: decide for you. It reports counts, shares, verdicts and UNMEASURED.
// M5 (chrome inventory, layered), M6–M8 (listeners, matched styles, dialogs — the
// relocation questions, which the keep-list makes N/A unless something actually moves) and
// M9 (colour) stay manual.
//
// Exit: 0 measured · 2 bad usage · 3 no browser.

import { openLab } from './lib/harness.mjs';

const HELP = `Usage: survey-recon.mjs --origin <url> --shapes <label=path,...> [options]

  --origin <url>        scheme + host, e.g. https://example.com
  --shapes a=/,b=/x     URL shapes to measure. Include the LOOKALIKES (a watch page, a
                        profile, a photo gallery): the ones that must NOT qualify are the
                        ones worth measuring.
                        A shape written  watch=follow:/  is RESOLVED BY FOLLOWING a real
                        unit link from that path, rather than by inventing a URL. Use it
                        for watch pages: a guessed slug returns a 404 that still renders a
                        related grid, and measuring that says nothing.
  --unit-href <str>     substring identifying a unit's link (CONTAINS, never a prefix
                        [F-HREF-PREFIX-MISSES]). Omit to auto-detect and report the guess.
  --widths 1280,1512    desktop widths for M11 (default 1280,1512,1920,2560)
  --bar <sel>           the top bar, for M5's keep-list (default: header, [class*="top-menu"])
  --browser-url <url>   REQUIRED, or PL_BROWSER_URL. No default: :9222 is usually the
                        operator's own browser [F-RAN-AGAINST-THE-OPERATORS-BROWSER].
  --json                emit raw JSON instead of the table
`;

function parse(argv) {
  const o = { browserUrl: process.env.PL_BROWSER_URL || null, widths: [1280, 1512, 1920, 2560] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--origin') o.origin = argv[++i];
    else if (a === '--shapes') o.shapes = argv[++i];
    else if (a === '--unit-href') o.unitHref = argv[++i];
    else if (a === '--bar') o.bar = argv[++i];
    else if (a === '--widths') o.widths = String(argv[++i]).split(',').map(Number).filter(Boolean);
    else if (a === '--browser-url') o.browserUrl = argv[++i];
    else if (a === '--json') o.json = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

let opts;
try { opts = parse(process.argv.slice(2)); } catch (e) {
  process.stderr.write(`survey-recon: ${e.message}\n\n${HELP}`); process.exit(2);
}
if (opts.help) { process.stdout.write(HELP); process.exit(0); }
if (!opts.origin || !opts.shapes) {
  process.stderr.write(`survey-recon: --origin and --shapes are required.\n\n${HELP}`); process.exit(2);
}
if (!opts.browserUrl) {
  process.stderr.write(
    'survey-recon: no browser given. Pass --browser-url <url> or set PL_BROWSER_URL.\n' +
    'There is deliberately no default: :9222 is usually the operator\'s own browser, and a\n' +
    'userscript installed there measures instead of the stock page you think you are surveying.\n');
  process.exit(3);
}

const shapes = opts.shapes.split(',').map((s) => {
  const [label, ...rest] = s.split('=');
  const raw = rest.join('=').trim();
  return raw.startsWith('follow:')
    ? { label: label.trim(), follow: raw.slice('follow:'.length) || '/' }
    : { label: label.trim(), path: raw };
});

const j = JSON.stringify;
const origin = opts.origin.replace(/\/+$/, '');

const lab = await openLab({ browserUrl: opts.browserUrl });

/** Poll for content rather than sleeping at it — a fixed sleep races the site's own JS. */
async function goto(url) {
  await lab.navigate(url);
  let n = null;
  for (let i = 0; i < 40; i += 1) {
    n = await lab.ev('document.querySelectorAll("a[href]").length').catch(() => 0);
    if (n >= 15) break;
    await new Promise((r) => setTimeout(r, 250));
    n = null;
  }
  if (n === null) return null;
  // Scroll the document before measuring anything. A lazily-rendered grid is simply absent
  // from a single enumeration taken at settle: measured on one site, video links went from
  // 66 to 109 across one scroll pass, so both the container ranking and the organic share
  // would have been computed from a little over half the grid [F-LAZY-GRID-UNDER-REPORTS].
  await lab.ev(`(async()=>{const step=700;
    const max=Math.min(document.documentElement.scrollHeight,12000);
    for(let y=0;y<max;y+=step){window.scrollTo(0,y);await new Promise(r=>setTimeout(r,220));}
    window.scrollTo(0,0);await new Promise(r=>setTimeout(r,500));return 1})()`);
  return lab.ev('document.querySelectorAll("a[href]").length').catch(() => n);
}
const setWidth = (w) => lab.client.send('Emulation.setDeviceMetricsOverride',
  { width: w, height: 900, deviceScaleFactor: 0, mobile: false }, lab.sessionId);
const clearWidth = () => lab.client.send('Emulation.clearDeviceMetricsOverride', {}, lab.sessionId);

/**
 * Candidate containers, ranked by how many CHILDREN carry a unit link — never by how many
 * links they contain. A promotional strip is dense with links and has few children; the real
 * grid is the opposite, and ranking on raw link count puts the promo first. Only containers
 * that RENDER are considered: a page can hold a qualifying grid inside a `display:none`
 * parent beside a visible non-qualifying one, and `querySelector` returns the invisible one.
 */
const containersExpr = (href) => `(()=>{
  const HREF=${j(href || '')};
  const hit=a=>{const h=a.getAttribute('href')||'';return HREF?h.includes(HREF):/\\/(videos?|watch|clips?|v)[\\/.\\-]/i.test(h)};
  const renders=e=>{const c=getComputedStyle(e);
    if(c.display==='none'||c.visibility==='hidden')return false;
    const r=e.getBoundingClientRect();return r.width>300&&r.height>150};
  /* A class token carrying a build hash is NOT an anchor — it changes on the site's next
     deploy. Marking it here is the no-framework-class rule enforced mechanically, the same
     job selector-verify.mjs does with its GENERATED verdict. */
  const gen=t=>/-[0-9a-f]{4,}$/i.test(t)||/-\\d{4,}$/.test(t)||/^[a-z]+_(?=[A-Za-z0-9]*\\d)[A-Za-z0-9]{5,}$/.test(t);
  /* sig() returns a USABLE SELECTOR and nothing else. An earlier version appended a
     "[GENERATED]" note to the same string, which was then handed to querySelector and
     matched nothing — three shapes reported UNMEASURED on grids that were sitting right
     there. A display annotation never rides on the value another call consumes. */
  const sig=e=>{const cls=(typeof e.className==='string'&&e.className)
      ?e.className.trim().split(/\\s+/).slice(0,3):[];
    return e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+(cls.length?'.'+cls.join('.'):'')};
  const isGen=e=>{const cls=(typeof e.className==='string'&&e.className)
      ?e.className.trim().split(/\\s+/).slice(0,3):[];return cls.some(gen)};
  /* ROWS is the third qualifying signal, and the one that separates the surface from a
     RAIL. A related-videos carousel beside a player is a strip of video cards that previews
     and links to videos - it satisfies both other signals and is still out of scope. A rail
     lays its children on ONE row and usually scrolls horizontally; the surface stacks them.
     Without this test the ranking picked a carousel on three shapes of one site, each
     scoring an organic share of 1.00 because a rail is all units [F-A-RAIL-PASSES-TWO-OF-THREE]. */
  const rowsOf=el=>new Set([...el.children]
    .filter(k=>k.getBoundingClientRect().height>20)
    .map(k=>Math.round(k.getBoundingClientRect().top/10))).size;
  const railish=el=>{const c=getComputedStyle(el);
    return /auto|scroll/.test(c.overflowX)&&el.scrollWidth>el.clientWidth*1.2};
  /* CARD-SHAPED children that no unit-link test matched. The difference between "this page
     is not a gallery" and "my href test is wrong" is not cosmetic: one card type routinely
     resolves through MORE THAN ONE route, and on one site a whole shape served its cards
     through an opaque redirect - 73 cards, 0 matched, reported as "does not qualify" on a
     page that plainly qualifies [F-ONE-CARD-TYPE-TWO-ROUTES]. Saying "not a gallery" there
     is a claim; saying "nothing matched, here is a sample href" is a measurement. */
  const cardish=k=>{const r=k.getBoundingClientRect();
    return r.width>80&&r.height>60&&!!k.querySelector('img')&&!!k.querySelector('a[href]')};
  const out=[],rails=[],nearMiss=[];
  for(const el of document.querySelectorAll('div,ul,section,main,ol')){
    const kids=[...el.children];
    if(kids.length<4)continue;
    if(!renders(el))continue;
    const unitKids=kids.filter(k=>[...k.querySelectorAll('a[href]')].some(hit));
    if(unitKids.length<4){
      const cards=kids.filter(cardish);
      if(cards.length>=8&&cards.length/kids.length>=0.6){
        const a=cards[0].querySelector('a[href]');
        nearMiss.push({el,cards:cards.length,kids:kids.length,
          sample:a?(a.getAttribute('href')||'').slice(0,70):null});}
      continue;}
    const rows=rowsOf(el);
    if(rows<2||railish(el)){ rails.push({el,rows,unitKids:unitKids.length}); continue; }
    out.push({el,kids:kids.length,unitKids:unitKids.length,rows});
  }
  /* outermost only: a grid nested in a wrapper would otherwise report twice */
  const keep=out.filter(c=>!out.some(o=>o!==c&&c.el.contains(o.el)));
  /* A container anchored on hashed classes loses a tie: those names rot. Measured, one such
     class stopped matching between two loads MINUTES apart [F-GENERATED-CLASS-ROTS-IN-MINUTES]. */
  keep.sort((a,b)=>(b.unitKids-a.unitKids)||(isGen(a.el)-isGen(b.el)));
  /* MARK THE WINNER. Everything downstream used to re-resolve the winner from its class
     SIGNATURE, and a signature is not a selector: on one site three separate containers
     shared the string div.js-media-list.grid.h-fit, so querySelector returned the FIRST -
     not the node that was scored. Unit box came back 0x0, every width column came back
     "?", the hover probe aimed its pointer at the wrong element and reported UNMEASURED,
     and the verdict line still said the shape qualified. Silent, and exactly the failure
     this tool exists to catch [F-A-SIGNATURE-IS-NOT-A-SELECTOR].
     An attribute on the element itself cannot be ambiguous. */
  for(const el of document.querySelectorAll('[data-sr-grid]')) el.removeAttribute('data-sr-grid');
  if(keep.length) keep[0].el.setAttribute('data-sr-grid','');
  const railNote=rails.filter(r=>!out.some(o=>o.el.contains(r.el))).slice(0,3)
    .map(r=>sig(r.el)+' rows='+r.rows+' units='+r.unitKids);
  const missNote=nearMiss.filter(m=>!nearMiss.some(o=>o!==m&&m.el.contains(o.el)))
    .sort((a,b)=>b.cards-a.cards).slice(0,2)
    .map(m=>sig(m.el)+' cards='+m.cards+'/'+m.kids+' sampleHref='+m.sample);
  if(!keep.length)return {none:true,railsSeen:railNote,nearMiss:missNote};
  return keep.slice(0,3).map(c=>{
    const r=c.el.getBoundingClientRect();
    const first=c.el.querySelector(':scope > *');
    const nonUnit=[...c.el.children].filter(k=>![...k.querySelectorAll('a[href]')].some(hit));
    return {sel:sig(c.el),generated:isGen(c.el),
      matches:document.querySelectorAll(sig(c.el)).length,
      kids:c.kids,unitKids:c.unitKids,rows:c.rows,
      share:+(c.unitKids/c.kids).toFixed(3),
      display:getComputedStyle(c.el).display,
      box:Math.round(r.width)+'x'+Math.round(r.height),
      childSig:first?sig(first):null,
      /* the class of leftover a keeper-based sweep cannot see
         [F-INSIDE-THE-GRID-IS-NOT-A-CARD] */
      nonUnitChildren:nonUnit.slice(0,4).map(k=>sig(k)+(isGen(k)?' [GENERATED]':'')+' '+
        Math.round(k.getBoundingClientRect().width)+'x'+Math.round(k.getBoundingClientRect().height))};
  });})()`;

/** Every distinct href SHAPE under the winning container, digits collapsed. */
const MARK = '[data-sr-grid]';
const hrefShapesExpr = () => `(()=>{
  const g=document.querySelector('[data-sr-grid]'); if(!g)return [];
  const seen={};
  for(const a of g.querySelectorAll('a[href]')){
    /* Normalise to a PATH first: an absolute href sliced by segment collapses to its own
       origin and hides the shape it was supposed to reveal. */
    let raw=a.getAttribute('href')||'';
    try{ raw=new URL(raw, location.href).pathname; }catch(e){ raw=raw.split('?')[0]; }
    const k=raw.replace(/[0-9a-f]{6,}/gi,'H').replace(/[0-9]{2,}/g,'N')
      .split('/').slice(0,3).join('/');
    seen[k]=(seen[k]||0)+1;}
  return Object.entries(seen).sort((a,b)=>b[1]-a[1]).slice(0,6);})()`;

const unitExpr = (href) => `(()=>{
  const g=document.querySelector('[data-sr-grid]'); if(!g)return null;
  const HREF=${j(href || '')};
  const hit=a=>{const h=a.getAttribute('href')||'';return HREF?h.includes(HREF):/\\/(videos?|watch|clips?|v)[\\/.\\-]/i.test(h)};
  const unit=[...g.children].find(k=>[...k.querySelectorAll('a[href]')].some(hit));
  if(!unit)return null;
  /* Bring the unit INTO THE VIEWPORT before reporting its centre. The hover probe moves a
     trusted pointer to these coordinates, and a point below the fold receives nothing - the
     preview then reads as "this site does not autoplay on hover" when the pointer simply
     never arrived. The grid's first unit is off-screen on any page with a masthead. */
  unit.scrollIntoView({block:'center'});
  const r=unit.getBoundingClientRect();
  const img=unit.querySelector('img');
  const attrs=img?[...img.attributes].map(a=>a.name).filter(n=>
    /^(src|srcset|data-|loading)/.test(n)):[];
  const sig=e=>e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+
    (typeof e.className==='string'&&e.className?'.'+e.className.trim().split(/\\s+/).slice(0,3).join('.'):'');
  return {sel:sig(unit),box:Math.round(r.width)+'x'+Math.round(r.height),
    ratio:r.height?+(r.width/r.height).toFixed(2):null,
    imgAttrs:attrs, hasVideoTag:!!unit.querySelector('video'),
    x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)};})()`;

/** M12 — a stock dark theme is a major finding: driving it beats overpainting it. */
const themeExpr = `(()=>{
  let prefersDark=0, crossOrigin=0, rules=0;
  for(const s of document.styleSheets){
    try{ const rs=s.cssRules; rules+=rs.length;
      for(const r of rs) if(r.conditionText&&/prefers-color-scheme/.test(r.conditionText)) prefersDark++;
    }catch(e){ crossOrigin++; }}
  /* The BODY element is routinely TRANSPARENT, and rgba(0,0,0,0) parses to three zeroes
     - which is
     black. Reading it naively reported a stock DARK THEME on a white site, on every shape.
     Walk to the first ancestor that actually paints, and fall back to white, which is what
     the viewport paints when nothing else does [F-TRANSPARENT-IS-NOT-BLACK]. */
  const opaque=e=>{for(let n=e;n;n=n.parentElement){
    const c=getComputedStyle(n).backgroundColor;
    const p=(c.match(/[\\d.]+/g)||[]).map(Number);
    if(p.length>=3&&(p.length<4||p[3]>0.05))return c;}
    return 'rgb(255, 255, 255)'};
  /* STATEFUL THEMES. A site's ground can come from a stored preference rather than from a
     media query, so a survey run in a REUSED throwaway profile measures the profile. One
     site read rgb(255,255,255) on a fresh profile in the morning and rgb(22,22,22) on the
     same profile that evening, after a stored user_theme_fav key had accumulated
     [F-A-THEME-CAN-BE-STATEFUL]. */
  let stateful=null;
  try{ const k=Object.keys(localStorage).filter(x=>/theme|dark|night|scheme/i.test(x));
    if(k.length) stateful='localStorage: '+k.slice(0,3).join(', '); }catch(e){}
  if(!stateful&&/theme|dark|night|scheme/i.test(document.cookie||'')) stateful='a cookie';
  const bg=opaque(document.body);
  const m=(bg.match(/[\\d.]+/g)||[255,255,255]).map(Number);
  const lum=(0.2126*m[0]+0.7152*m[1]+0.0722*m[2])/255;
  const toggle=document.querySelector('[class*="night"],[class*="dark-mode"],[id*="night"],[class*="theme-toggle"]');
  return {bodyBg:bg, bodyLuminance:+lum.toFixed(3), stockDark:lum<0.25,
    prefersColorSchemeBlocks:prefersDark, sheets:document.styleSheets.length,
    rules, crossOriginSheets:crossOrigin,
    stateful,
    toggleLike: toggle?toggle.tagName+(toggle.id?'#'+toggle.id:'.'+String(toggle.className).split(/\\s+/)[0]):null};})()`;

/**
 * PAGINATION, and it is a QUALIFYING SIGNAL rather than a nice-to-have.
 *
 * A pager with at least one real page link is the characteristic every page this method
 * targets shares, and the pages it excludes are exactly the awkward ones: a watch page has
 * none, and neither does an infinite-scroll shape. Measured across four sites on
 * 2026-09-13, it rejected a watch page whose related strip otherwise scored an organic
 * share of 1.00 and passed every other signal [F-PAGINATION-IS-A-QUALIFYING-SIGNAL].
 *
 * A pager ELEMENT is not enough. One site's infinite-scroll shape ships a
 * `#load-more-container` holding a label `span` and ZERO anchors; keying on the container
 * would readmit precisely the page the rule exists to exclude. Count LINKS.
 *
 * Named selectors first because they are cheap and legible, then a structural pass: a
 * rendered element holding 3+ links that differ by a page token. The structural pass is
 * what covers a site whose pager carries a hashed class.
 */
const pagerExpr = (unitHref) => `(()=>{
  const U=${j(unitHref || '')};
  /* A PAGER NEVER LINKS TO A UNIT. Without this guard the structural pass matched a CARD:
     div#video_<id>.thumb-block, whose own links end in a slug carrying digits, scored 3
     "page links" and was reported as the page's pagination
     [F-A-CARD-IS-NOT-A-PAGER]. */
  const unitLink=a=>{const h=a.getAttribute('href')||'';
    return U?h.includes(U):/\\/(videos?|watch|clips?|v)[\\/.\\-]/i.test(h)};
  const sig=e=>e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+
    (typeof e.className==='string'&&e.className?'.'+e.className.trim().split(/\\s+/)[0]:'');
  const paged=a=>{let p;try{p=new URL(a.getAttribute('href')||'',location.href)}catch(x){return false}
    const s=p.pathname+p.search;
    return /(?:[?&](?:p|page|from)=\\d+)|(?:\\/\\d{1,4}(?:\\/|$))|(?:-\\d{1,4}(?:\\/|$))/.test(s)};
  const renders=e=>{const c=getComputedStyle(e);
    return c.display!=='none'&&c.visibility!=='hidden'&&e.getBoundingClientRect().height>4};
  const named=['.pagination','.numlist2','nav[aria-label*="age"]','[class*="pagin"]',
    '[class*="pager"]','[class*="page-list"]','[class*="load-more"]','[class*="loadmore"]'];
  for(const sel of named){
    for(const e of document.querySelectorAll(sel)){
      if(!renders(e))continue;
      const as=[...e.querySelectorAll('a[href]')];
      if(as.some(unitLink))continue;
      const links=as.filter(paged).length;
      if(links>=1) return {found:sig(e), links, how:'named'};}}
  /* structural: a hashed-class pager still looks like a pager */
  const cands=[];
  for(const e of document.querySelectorAll('div,nav,ul,section')){
    if(!renders(e))continue;
    const as=[...e.querySelectorAll('a[href]')];
    if(as.length<3||as.length>60)continue;
    if(as.some(unitLink))continue;
    /* DISTINCT targets: three links to the same page are not three pages. */
    const tokens=new Set();
    for(const a of as){ if(!paged(a))continue;
      let p;try{p=new URL(a.getAttribute('href')||'',location.href)}catch(x){continue}
      tokens.add(p.pathname+p.search);}
    const n=tokens.size;
    if(n>=3&&n/as.length>=0.5) cands.push({e,n});}
  const outer=cands.filter(c=>!cands.some(o=>o!==c&&c.e.contains(o.e)));
  if(outer.length) return {found:sig(outer[0].e), links:outer[0].n, how:'structural'};
  return {found:null, links:0, how:null};})()`;

/**
 * M5 — the chrome inventory, as a COUNT with identities rather than a list to maintain.
 *
 * Everything that paints and is neither the surface, nor the pager, nor the bar, nor on the
 * path between the surface and <body>. A node counts as painting when IT or anything in its
 * subtree does: a collapsed float container measures height 0 with visible children, and a
 * height filter cannot see it — that is how one block survived four sweeps
 * [F-INSIDE-THE-GRID-IS-NOT-A-CARD, F-PURGE-IS-LAYERED].
 *
 * PURGING IS LAYERED: removing what is visible exposes what was behind it, so re-run this
 * after every removal. One pass is never the answer.
 */
const chromeExpr = (gridSel, barSel) => `(()=>{
  const gen=t=>/-[0-9a-f]{4,}$/i.test(t)||/-\\d{4,}$/.test(t)||/^[a-z]+_(?=[A-Za-z0-9]*\\d)[A-Za-z0-9]{5,}$/.test(t);
  const cls=e=>(typeof e.className==='string'&&e.className)
    ?e.className.trim().split(/\\s+/).slice(0,2):[];
  const sig=e=>e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+
    (cls(e).length?'.'+cls(e).join('.'):'')+(cls(e).some(gen)?' [GENERATED]':'')
    +(!e.id&&!cls(e).length?' [NO CLASS]':'');
  const paints=e=>{const c=getComputedStyle(e);
    if(c.display==='none'||c.visibility==='hidden')return false;
    const r=e.getBoundingClientRect(); if(r.height>4&&r.width>20)return true;
    for(const k of e.querySelectorAll('*')){const kc=getComputedStyle(k);
      if(kc.display==='none'||kc.visibility==='hidden')continue;
      const kr=k.getBoundingClientRect(); if(kr.height>4&&kr.width>20)return true;}
    return false;};
  const grid=document.querySelector(${j(gridSel)});
  if(!grid)return {noGrid:true};
  const bar=document.querySelector(${j(barSel)});
  const pagerSels='.pagination,.numlist2,[class*="pagin"],[class*="pager"],[class*="page-list"]';
  const keep=e=>e===grid||grid.contains(e)||(bar&&(e===bar||bar.contains(e)))
    ||!!e.closest(pagerSels);
  const onPath=e=>e.contains(grid);
  const out=[],seen=[];
  const walk=(n,d)=>{for(const k of n.children){
    if(!paints(k)||keep(k))continue;
    if(onPath(k)){ if(d>0) walk(k,d-1); continue; }
    const r=k.getBoundingClientRect();
    out.push(sig(k)+' '+Math.round(r.width)+'x'+Math.round(r.height));}};
  walk(document.body,7);
  return {count:out.length, blocks:out.slice(0,12),
    hashed:out.filter(x=>/GENERATED|NO CLASS/.test(x)).length};})()`;

const report = [];
for (const sh of shapes) {
  let url = sh.path === undefined ? null : origin + sh.path;
  if (sh.follow !== undefined) {
    // Follow a REAL card, FROM THE GRID. A guessed watch URL is a 404 that still renders a
    // related grid — and a whole-document search is the quieter failure: the default href
    // heuristic matched a nav link (a /videos-i-like recently-watched entry sits before any
    // card in the DOM) and produced a confident non-qualifying verdict for a page that was
    // never a watch page at all. Found by a Sonnet trial [F-FOLLOW-FROM-THE-GRID].
    // So: find a multi-row container whose children carry unit links, and follow ITS first
    // unit. Only when no such grid exists fall back to the document, and say so.
    const from = origin + sh.follow;
    if (await goto(from) !== null) {
      const href = await lab.ev(`(()=>{const H=${j(opts.unitHref || '')};
        const hit=a=>{const h=a.getAttribute('href')||'';
          return H?h.includes(H):/\\/(videos?|watch|clips?|v)[\\/.\\-]/i.test(h)};
        const rows=g=>new Set([...g.children].filter(k=>k.getBoundingClientRect().height>20)
          .map(k=>Math.round(k.getBoundingClientRect().top/10))).size;
        let best=null;
        for(const g of document.querySelectorAll('div,ul,section,main,ol')){
          const cs=getComputedStyle(g);
          if(cs.display==='none'||cs.visibility==='hidden')continue;
          const r=g.getBoundingClientRect(); if(r.width<300||r.height<150)continue;
          const units=[...g.children].filter(k=>[...k.querySelectorAll('a[href]')].some(hit));
          if(units.length<4)continue;
          if(rows(g)<2)continue;
          if(!best||units.length>best.n) best={n:units.length,u:units[0]};}
        if(best){const a=[...best.u.querySelectorAll('a[href]')].find(hit);
          if(a)return {href:a.href, how:'grid'};}
        const a=[...document.querySelectorAll('a[href]')].find(hit);
        return a?{href:a.href, how:'document'}:null})()`);
      if (href && href.how === 'document') {
        process.stderr.write(`follow: no qualifying grid on ${from} — followed the first `
          + `document-order match instead. Verify the landed URL is really a unit page.\n`);
      }
      url = href ? href.href : null;
    }
    if (!url) {
      report.push({ shape: sh.label, url: from, error: 'FOLLOW FAILED — no unit link found' });
      continue;
    }
  }
  const row = { shape: sh.label, url };
  const links = await goto(url);
  if (links === null) { row.error = 'NAV FAILED'; report.push(row); continue; }
  await setWidth(1512);

  const cands = await lab.ev(containersExpr(opts.unitHref));
  if (!Array.isArray(cands)) {
    row.containers = [];
    row.qualifies = false;
    if (cands?.nearMiss?.length) {
      // Loudest case first: a card-shaped grid is sitting there and NOTHING matched the
      // href test. That is a broken test, not a non-qualifying page.
      row.why = `HREF TEST PROBABLY WRONG — card-shaped grid found, 0 children matched `
        + `${opts.unitHref ? j(opts.unitHref) : 'the default /videos?|watch|clip/ heuristic'}: `
        + cands.nearMiss.join(' · ');
      row.hrefTestSuspect = true;
    } else if (cands?.railsSeen?.length) {
      row.why = `only RAILS carry unit links (single-row / horizontally scrolling): ${cands.railsSeen.join(' · ')}`;
    } else {
      row.why = 'no rendering, multi-row container whose children carry unit links';
    }
    report.push(row); continue;
  }
  row.containers = cands;
  if (!cands.length) {
    row.qualifies = false;
    row.why = 'no rendering container whose children carry unit links';
    report.push(row); continue;
  }
  const win = cands[0];
  row.grid = win.sel;
  row.organicShare = win.share;
  row.hrefShapes = await lab.ev(hrefShapesExpr());
  const unit = await lab.ev(unitExpr(opts.unitHref));
  row.unit = unit;

  // Hover autoplay. Three things have to be true before a verdict means anything, and the
  // first version of this probe got two of them wrong ON THE SAME SITE — a false NO where an
  // overlay covered the card, and a false YES where it found a playing video somewhere else
  // in the grid [F-HOVER-PROBE-NEEDS-A-RIG].
  //
  //   1. The pointer must ARRIVE. Hit-test the point: if `elementFromPoint` is not inside
  //      the unit, something is covering it, and "no preview" says nothing.
  //   2. `:hover` must actually SET on the unit — the rig assertion the survey demands
  //      before any NULL result is believed.
  //   3. The preview must be found INSIDE the hovered unit, never anywhere in the grid.
  //
  // A probe that cannot satisfy 1 and 2 reports UNMEASURED and names the blocker. UNMEASURED
  // is a finding; NO is a claim.
  if (unit) {
    const hoverSel = j(MARK);
    let verdict = null; let blocker = null;
    for (let attempt = 0; attempt < 4 && verdict === null; attempt += 1) {
      const pick = await lab.ev(`(()=>{const g=document.querySelector(${hoverSel});
        if(!g)return null;
        const HREF=${j(opts.unitHref || '')};
        const hit=a=>{const h=a.getAttribute('href')||'';
          return HREF?h.includes(HREF):/\\/(videos?|watch|clips?|v)[\\/.\\-]/i.test(h)};
        const units=[...g.children].filter(k=>[...k.querySelectorAll('a[href]')].some(hit));
        const u=units[${'${attempt}'}]; if(!u)return null;
        u.scrollIntoView({block:'center'});
        window.__srUnit=u;
        const r=u.getBoundingClientRect();
        return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`
        .replace('${attempt}', String(attempt)));
      if (!pick) break;
      await lab.movePointer(pick.x, pick.y);
      await new Promise((r) => setTimeout(r, 350));
      const rig = await lab.ev(`(()=>{const u=window.__srUnit; if(!u)return null;
        const el=document.elementFromPoint(${pick.x},${pick.y});
        const covered=!(el&&(u.contains(el)||el===u));
        const sig=e=>e?e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+
          (typeof e.className==='string'&&e.className?'.'+e.className.trim().split(/\\s+/)[0]:''):null;
        return {covered, hover:u.matches(':hover'), by:covered?sig(el):null}})()`);
      if (!rig) break;
      if (rig.covered || !rig.hover) { blocker = rig.by || 'pointer did not set :hover'; continue; }
      let preview = false;
      for (let i = 0; i < 12; i += 1) {
        preview = await lab.ev(`(()=>{const u=window.__srUnit; if(!u)return false;
          for(const v of u.querySelectorAll('video')){
            const r=v.getBoundingClientRect();
            if(r.height>20&&(v.currentTime>0||!v.paused||v.readyState>2))return true;}
          const i=u.querySelector('img');
          return !!(i&&i.dataset.srSeen&&i.dataset.srSeen!==(i.currentSrc||i.src))})()`);
        if (preview) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      verdict = preview;
    }
    row.hoverAutoplay = verdict;          // null === UNMEASURED
    row.hoverBlocker = verdict === null ? blocker : null;
    await lab.movePointer(5, 700);
  }

  row.pagination = await lab.ev(pagerExpr(opts.unitHref));
  // FOUR signals, not three. The pager is the one that rejects a watch page whose related
  // strip passes all the others [F-PAGINATION-IS-A-QUALIFYING-SIGNAL].
  row.qualifies = !!(row.organicShare >= 0.5 && win.unitKids >= 4 && row.pagination.links >= 1);
  row.widths = [];
  for (const w of opts.widths) {
    await setWidth(w);
    // The first CHILD is not the first UNIT: a grid's leading child is routinely a float
    // clearer (0 height) or a <script> (0x0), so measuring it reports a unit box of
    // `1268x0` or `0x0` and a nonsense column count. Measured on two shapes of the first
    // site this tool was ever pointed at — the very class of node it exists to surface
    // [F-INSIDE-THE-GRID-IS-NOT-A-CARD].
    row.widths.push(await lab.ev(`(()=>{const g=document.querySelector('[data-sr-grid]');
      const de=document.documentElement;
      const HREF=${j(opts.unitHref || '')};
      const hit=a=>{const h=a.getAttribute('href')||'';
        return HREF?h.includes(HREF):/\\/(videos?|watch|clips?|v)[\\/.\\-]/i.test(h)};
      const u=g?[...g.children].find(k=>{
        if(![...k.querySelectorAll('a[href]')].some(hit))return false;
        const r=k.getBoundingClientRect();return r.width>20&&r.height>20}):null;
      const ur=u?u.getBoundingClientRect():null;
      return {w:${w}, overflowX:Math.max(0,de.scrollWidth-de.clientWidth),
        unit:ur?Math.round(ur.width)+'x'+Math.round(ur.height):null,
        cols:(g&&ur&&ur.width)?Math.max(1,Math.round(g.getBoundingClientRect().width/ur.width)):null}})()`));
  }
  await setWidth(1512);
  row.chrome = await lab.ev(chromeExpr(MARK,
    opts.bar || 'header, [class*="top-menu"]'));
  // A left-behind override makes every later measurement in the session wrong.
  await clearWidth();
  /* LAST, because both scheme passes RE-NAVIGATE — and a navigation destroys the
     data-sr-grid mark every measurement above depends on. Running this earlier returned
     the widths as "?" and dropped the M5 inventory entirely, silently. */
  /* BOTH SCHEMES. M12 is the measure that can invalidate a plan outright, and a site whose
     dark ground comes from a media query is dark only for a reader whose OS agrees. Reading
     it once, under whatever the surveying machine happens to be set to, answers a different
     question than the one asked [F-M12-IS-TWO-MEASUREMENTS]. */
  /* EACH PASS STARTS FROM A WIPED ORIGIN, and the reload after the wipe is the actual
     measurement. Measured on SITE-B: the site detects prefers-color-scheme in JS (zero CSS
     scheme blocks) and PERSISTS the answer to localStorage on the first visit — fresh+dark
     reads rgb(22,22,22), fresh+light reads rgb(255,255,255), and whichever pass runs first
     writes the key that pins the second, so an uncleared comparison reports
     "same under both schemes" for a site that genuinely follows the OS
     [F-FIRST-VISIT-PERSISTS-THE-SCHEME]. Clearing between passes is what makes the two
     numbers commensurable. Cookie clearing is best-effort and REPORTED, never assumed:
     the CDP calls have measured failure modes (Network.clearBrowserCookies needs
     Network.enable first; Storage.clearDataForOrigin returned a bare Internal error). */
  const scheme = async (v) => {
    await lab.client.send('Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: v }] }, lab.sessionId);
    await goto(url);
    const priorKeys = await lab.ev(`(()=>{try{
      const k=Object.keys(localStorage).filter(x=>/theme|dark|night|scheme/i.test(x));
      localStorage.clear();sessionStorage.clear();return k}catch(e){return null}})()`);
    let cookiesCleared = true;
    try {
      await lab.client.send('Network.enable', {}, lab.sessionId);
      await lab.client.send('Network.clearBrowserCookies', {}, lab.sessionId);
    } catch { cookiesCleared = false; }
    await goto(url);
    const t = await lab.ev(themeExpr);
    /* themeExpr's stateful now means: written by the site ON THIS FRESH LOAD. */
    return { ...t, priorKeys, cookiesCleared };
  };
  const dark = await scheme('dark');
  const light = await scheme('light');
  await lab.client.send('Emulation.setEmulatedMedia', { features: [] }, lab.sessionId);
  await goto(url);
  row.theme = { ...dark, darkScheme: dark, lightScheme: light,
                schemeDependent: dark.stockDark !== light.stockDark };

  report.push(row);
}
await lab.close();

if (opts.json) {
  /* SAME PRIVACY DISCIPLINE AS THE TABLE. The renderer collapses ids and slugs; --json used
     to emit them verbatim — full explicit title slugs, on the tool's own automation path,
     against the survey's own rule. Structure is what automation needs; content is what the
     rule forbids. Collapse hex runs and digit runs, and slug words past the route segment. */
  const scrub = (v) => {
    if (typeof v === 'string') {
      return v.replace(/[0-9a-f]{6,}/gi, 'H').replace(/[0-9]{2,}/g, 'N')
        .replace(/((?:videos?|video|watch|clips?)[./-])[A-Za-z0-9%+_-]{12,}/gi, '$1SLUG');
    }
    if (Array.isArray(v)) { return v.map(scrub); }
    if (v && typeof v === 'object') {
      const o = {}; for (const k of Object.keys(v)) { o[k] = scrub(v[k]); } return o;
    }
    return v;
  };
  process.stdout.write(`${JSON.stringify(scrub(report), null, 2)}\n`); process.exit(0);
}

const pad = (s, n) => String(s ?? '').padEnd(n);
process.stdout.write(`\n=== survey recon — ${origin} · ${shapes.length} shape(s) ===\n\n`);
process.stdout.write(`${pad('shape', 10)}${pad('qualifies', 10)}${pad('share', 7)}${pad('hover', 7)}${pad('pager', 7)}${pad('dark', 6)}grid\n`);
process.stdout.write(`${'-'.repeat(10)}${'-'.repeat(10)}${'-'.repeat(7)}${'-'.repeat(7)}${'-'.repeat(7)}${'-'.repeat(6)}----\n`);
for (const r of report) {
  if (r.error) { process.stdout.write(`${pad(r.shape, 10)}${r.error}\n`); continue; }
  process.stdout.write(
    `${pad(r.shape, 10)}${pad(r.qualifies ? 'YES' : 'no', 10)}${pad(r.organicShare ?? '-', 7)}` +
    `${pad(r.hoverAutoplay === undefined ? '-' : r.hoverAutoplay === null ? 'UNMEAS' : r.hoverAutoplay ? 'yes' : 'NO', 7)}` +
    `${pad(r.pagination?.found ? 'yes' : 'no', 7)}${pad(r.theme?.stockDark ? 'YES' : 'no', 6)}${r.grid ?? r.why ?? ''}\n`);
}
process.stdout.write('\n');
for (const r of report) {
  if (r.error || !r.grid) continue;
  process.stdout.write(`${r.shape}:\n`);
  process.stdout.write(`  unit      ${r.unit ? `${r.unit.sel}  ${r.unit.box} ratio ${r.unit.ratio}` : 'UNMEASURED'}\n`);
  if (r.unit?.imgAttrs?.length) process.stdout.write(`  media     ${r.unit.imgAttrs.join(' ')}\n`);
  process.stdout.write(`  hrefs     ${(r.hrefShapes || []).map(([k, n]) => `${k}(${n})`).join(' ')}\n`);
  if (r.hoverAutoplay === null) {
    process.stdout.write(`  hover     UNMEASURED — the pointer never reached a card${r.hoverBlocker ? `; covered by ${r.hoverBlocker}` : ''}.\n`
      + '            Not a "does not preview" verdict. Clear the blocker and re-run.\n');
  }
  /* The measurements above used the winning ELEMENT, via a temporary attribute. A userscript
     cannot do that, so a signature matching more than one node has to be said out loud. */
  if ((r.containers[0].matches ?? 1) > 1) {
    process.stdout.write(`  ANCHOR    AMBIGUOUS — ${r.containers[0].matches} elements share the winner's `
      + `signature ${r.containers[0].sel}.\n`
      + '            These numbers came from the winning ELEMENT; a userscript cannot. Find a\n'
      + '            scoping ancestor or a structural test before writing a selector.\n');
  }
  if (r.containers[0].generated) {
    process.stdout.write('  ANCHOR    the winner\'s classes carry a build hash [GENERATED] — do NOT anchor\n'
      + '            on them. Use a role, an href shape or a data attribute.\n');
  }
  if (r.containers.length > 1) {
    process.stdout.write(`  runners-up ${r.containers.slice(1).map((c) => `${c.sel} share ${c.share}`).join(' · ')}\n`);
  }
  if (r.containers[0].nonUnitChildren.length) {
    process.stdout.write(`  NON-UNIT CHILDREN (a keeper sweep cannot see these): ${r.containers[0].nonUnitChildren.join(' · ')}\n`);
  }
  if (r.theme.schemeDependent) {
    process.stdout.write('  THEME     SCHEME-DEPENDENT — the site is dark under one prefers-color-scheme\n'
      + `            and light under the other (dark: ${r.theme.darkScheme.bodyBg}, `
      + `light: ${r.theme.lightScheme.bodyBg}).\n`
      + '            A reader whose OS disagrees gets the other one. Do NOT record "ships dark".\n');
  } else {
    process.stdout.write(`  theme     same under both schemes — dark ${r.theme.darkScheme.bodyBg}, `
      + `light ${r.theme.lightScheme.bodyBg}\n`);
  }
  if (r.theme.stateful) {
    process.stdout.write(`  THEME     the site WRITES a preference on first visit (${r.theme.stateful}) —\n`
      + '            the scheme passes above cleared storage first, so they are commensurable;\n'
      + '            but any LATER single reading of this origin reports the pinned choice,\n'
      + '            not the site.\n');
  }
  if (r.theme.priorKeys && r.theme.priorKeys.length) {
    process.stdout.write(`  THEME     this profile ARRIVED with ${r.theme.priorKeys.join(', ')} — cleared before\n`
      + '            measuring, so the verdicts above are the site\'s, not the profile\'s.\n');
  }
  if (r.theme.cookiesCleared === false) {
    process.stdout.write('  THEME     cookie clearing FAILED — a cookie-persisted theme could still pin the\n'
      + '            comparison. Treat scheme-dependence as UNMEASURED if the two schemes agree.\n');
  }
  process.stdout.write(`  theme     bg ${r.theme.bodyBg} lum ${r.theme.bodyLuminance} · sheets ${r.theme.sheets} rules ${r.theme.rules} cross-origin ${r.theme.crossOriginSheets} · prefers-color-scheme blocks ${r.theme.prefersColorSchemeBlocks}${r.theme.toggleLike ? ` · toggle-like ${r.theme.toggleLike}` : ''}\n`);
  process.stdout.write(`  widths    ${r.widths.map((w) => `${w.w}:${w.unit ?? '?'}${w.overflowX ? ` OVERFLOW ${w.overflowX}` : ''}`).join('  ')}\n`);
  if (r.chrome && !r.chrome.noGrid) {
    process.stdout.write(`  M5 chrome ${r.chrome.count} rendered block(s) outside the keep-list`
      + `${r.chrome.hashed ? `, ${r.chrome.hashed} of them hashed or class-less — a NAMED purge list `
        + 'will rot; purge by elimination against your own marks' : ''}\n`);
    for (const b of r.chrome.blocks) process.stdout.write(`            ${b}\n`);
    process.stdout.write('            PURGING IS LAYERED — re-run after every removal.\n');
  }
  process.stdout.write(`  pager     ${r.pagination.found ?? 'NONE — this shape cannot qualify'}`
    + `${r.pagination.links ? ` (${r.pagination.links} page links, ${r.pagination.how})` : ' (0 page links)'}\n\n`);
}
process.stdout.write('M5 (chrome, LAYERED), M6-M8 (listeners/styles/dialogs — N/A unless something moves)\nand M9 (colour) are NOT measured here. UNMEASURED is a finding; do not infer them.\n');
