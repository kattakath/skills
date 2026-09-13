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
  --unit-href <str>     substring identifying a unit's link (CONTAINS, never a prefix
                        [F-HREF-PREFIX-MISSES]). Omit to auto-detect and report the guess.
  --widths 1280,1512    desktop widths for M11 (default 1280,1512,1920,2560)
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
  return { label: label.trim(), path: rest.join('=').trim() };
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
  const gen=t=>/-[0-9a-f]{4,}$/i.test(t)||/-\\d{4,}$/.test(t)||/^[a-z]+_[A-Za-z0-9]{5,}$/.test(t);
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
    return {sel:sig(c.el),generated:isGen(c.el),kids:c.kids,unitKids:c.unitKids,rows:c.rows,
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
const hrefShapesExpr = (sel) => `(()=>{
  const g=document.querySelector(${j(sel)}); if(!g)return [];
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

const unitExpr = (sel, href) => `(()=>{
  const g=document.querySelector(${j(sel)}); if(!g)return null;
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
  const bg=opaque(document.body);
  const m=(bg.match(/[\\d.]+/g)||[255,255,255]).map(Number);
  const lum=(0.2126*m[0]+0.7152*m[1]+0.0722*m[2])/255;
  const toggle=document.querySelector('[class*="night"],[class*="dark-mode"],[id*="night"],[class*="theme-toggle"]');
  return {bodyBg:bg, bodyLuminance:+lum.toFixed(3), stockDark:lum<0.25,
    prefersColorSchemeBlocks:prefersDark, sheets:document.styleSheets.length,
    rules, crossOriginSheets:crossOrigin,
    toggleLike: toggle?toggle.tagName+(toggle.id?'#'+toggle.id:'.'+String(toggle.className).split(/\\s+/)[0]):null};})()`;

const pagerExpr = `(()=>{
  const sels=['.pagination','[class*="pagin"]','[class*="pager"]','nav[aria-label*="age"]'];
  for(const s of sels){ const e=document.querySelector(s);
    if(e&&e.getBoundingClientRect().height>4){
      const sig=e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+
        (typeof e.className==='string'&&e.className?'.'+e.className.trim().split(/\\s+/)[0]:'');
      return {found:sig, links:e.querySelectorAll('a[href]').length};}}
  return {found:null, links:0};})()`;

const report = [];
for (const sh of shapes) {
  const url = origin + sh.path;
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
  row.hrefShapes = await lab.ev(hrefShapesExpr(win.sel));
  const unit = await lab.ev(unitExpr(win.sel, opts.unitHref));
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
    const hoverSel = j(win.sel);
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

  row.qualifies = !!(row.organicShare >= 0.5 && win.unitKids >= 4);
  row.pagination = await lab.ev(pagerExpr);
  row.theme = await lab.ev(themeExpr);

  row.widths = [];
  for (const w of opts.widths) {
    await setWidth(w);
    // The first CHILD is not the first UNIT: a grid's leading child is routinely a float
    // clearer (0 height) or a <script> (0x0), so measuring it reports a unit box of
    // `1268x0` or `0x0` and a nonsense column count. Measured on two shapes of the first
    // site this tool was ever pointed at — the very class of node it exists to surface
    // [F-INSIDE-THE-GRID-IS-NOT-A-CARD].
    row.widths.push(await lab.ev(`(()=>{const g=document.querySelector(${j(win.sel)});
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
  // A left-behind override makes every later measurement in the session wrong.
  await clearWidth();
  report.push(row);
}
await lab.close();

if (opts.json) { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); process.exit(0); }

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
  if (r.containers.length > 1) {
    process.stdout.write(`  runners-up ${r.containers.slice(1).map((c) => `${c.sel} share ${c.share}`).join(' · ')}\n`);
  }
  if (r.containers[0].nonUnitChildren.length) {
    process.stdout.write(`  NON-UNIT CHILDREN (a keeper sweep cannot see these): ${r.containers[0].nonUnitChildren.join(' · ')}\n`);
  }
  process.stdout.write(`  theme     bg ${r.theme.bodyBg} lum ${r.theme.bodyLuminance} · sheets ${r.theme.sheets} rules ${r.theme.rules} cross-origin ${r.theme.crossOriginSheets} · prefers-color-scheme blocks ${r.theme.prefersColorSchemeBlocks}${r.theme.toggleLike ? ` · toggle-like ${r.theme.toggleLike}` : ''}\n`);
  process.stdout.write(`  widths    ${r.widths.map((w) => `${w.w}:${w.unit ?? '?'}${w.overflowX ? ` OVERFLOW ${w.overflowX}` : ''}`).join('  ')}\n`);
  process.stdout.write(`  pager     ${r.pagination.found ?? 'none found'}${r.pagination.links ? ` (${r.pagination.links} links)` : ''}\n\n`);
}
process.stdout.write('M5 (chrome, LAYERED), M6-M8 (listeners/styles/dialogs — N/A unless something moves)\nand M9 (colour) are NOT measured here. UNMEASURED is a finding; do not infer them.\n');
