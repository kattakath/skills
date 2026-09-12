// Run a userscript's acceptance spec against the live page, using TRUSTED events.
//
// The gap this closes: `userscript-meta-lint.sh` says the file is publishable and
// `selector-verify.mjs` says the nodes are there. Neither says the redesign still WORKS.
// google-photos-icon-nav 3.0.0 passed both and shipped with its search dead — the button
// was present, 40x40 and hit-testable, and a trusted click on it opened nothing
// [F-PRESENT-NOT-WORKING]. Lint + geometry is not a gate; exercising the host's primary
// actions is.
//
// The spec is a .mjs module, not JSON, and deliberately so: the assertions a real redesign
// needs are arbitrary DOM expressions, and a JSON DSL would have to grow an expression
// language to express them. A module gets one for free.
//
//   // my-script.acceptance.mjs
//   export const urlMatch = 'example.com';
//   export default async function run(t) {
//     await t.inject();                       // teardown, inject, settle
//     const box = await t.rect('[role="navigation"]');
//     t.check('nav is off-canvas by default', box.x < 0, box);
//   }
//
// Exit: 0 every check passed · 1 at least one failed · 2 bad usage · 3 no matching page
// target · 7 this Node cannot speak WebSocket.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isAbsolute, resolve } from 'node:path';

import {
  attachPage,
  clearControlledInputExpr,
  createReport,
  EXIT_NO_TARGET,
  inject,
  settle,
} from './lib/harness.mjs';

const HELP = `Usage: userscript-acceptance.mjs [options] <spec.mjs>

  --script <path>        the .user.js under test (default: the spec's \`script\` export)
  --browser-url <url>    debug browser (default http://127.0.0.1:9222)
  --repeat <n>           run the whole spec n times; flakes show up as a changing score
  -h, --help             this text

The spec module exports:
  urlMatch   (required)  substring of the page target's URL — also the assertion that we
                         are on the right page, since a debug browser routinely holds
                         several page targets [F-FIRST-TARGET-WRONG]
  script     (optional)  path to the .user.js, relative to the spec
  default    (required)  async run(t) — see the toolkit on \`t\` below

t.ev(expr)                    evaluate in the page, throwing page-side exceptions
t.rect(sel) / t.rects(sel)    bounding boxes, rounded
t.hit(x, y, [withinSel])      what is really on top there, and whether it is inside withinSel
t.click(x, y) / t.clickSel(s) trusted mouse — NOT el.click()
t.type(text) / t.key(name)    trusted keyboard
t.settle(read, opts)          poll until a value stops changing; never sleep at a transition
t.inject() / t.teardown()     run the script / call its teardown contract
t.clearInput(sel)             empty a controlled input the way its framework accepts
t.check(name, pass, detail)   record an assertion
t.sleep(ms)                   last resort; prefer t.settle
`;

function parseArgs(argv) {
  const o = { browserUrl: 'http://127.0.0.1:9222', script: null, repeat: 1, spec: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--browser-url') o.browserUrl = argv[++i];
    else if (a === '--script') o.script = argv[++i];
    else if (a === '--repeat') o.repeat = Number(argv[++i]);
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (o.spec === null) o.spec = a;
    else throw new Error('only one spec may be given');
  }
  return o;
}

const die = (msg, code) => {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
};

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  die(`userscript-acceptance: ${err.message}\n\n${HELP}`, 2);
}
if (opts.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (opts.spec === null) die(HELP, 2);
if (!Number.isInteger(opts.repeat) || opts.repeat < 1) die('--repeat needs a positive integer', 2);

const specPath = resolve(opts.spec);
const spec = await import(pathToFileURL(specPath).href);
if (typeof spec.urlMatch !== 'string' || spec.urlMatch === '') {
  die(`${opts.spec}: must export a non-empty \`urlMatch\``, 2);
}
if (typeof spec.default !== 'function') {
  die(`${opts.spec}: must export a default async run(t)`, 2);
}

const scriptRel = opts.script ?? spec.script;
if (typeof scriptRel !== 'string') {
  die(`${opts.spec}: no script — pass --script or export \`script\``, 2);
}
const scriptPath = isAbsolute(scriptRel)
  ? scriptRel
  : resolve(specPath, '..', scriptRel);
const source = readFileSync(scriptPath, 'utf8');

const R = (expr) => `(()=>{const e=${expr};if(!e)return null;const b=e.getBoundingClientRect();
  return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)}})()`;

let page;
try {
  page = await attachPage(spec.urlMatch, { browserUrl: opts.browserUrl });
} catch (err) {
  die(err.message, err.exitCode ?? 1);
}

const { ev, sleep, click, clickSelector, type, key, selectAll } = page;

const teardown = async () => {
  // The contract this plugin's authoring skill requires: a global that undoes the run.
  // Called by name rather than by reloading, because a reload would also discard the
  // page state a spec may have built up on purpose.
  await ev(`(()=>{for(const k of Object.keys(window)){
      if(/^__nix.*Teardown$/.test(k)&&typeof window[k]==='function'){try{window[k]()}catch{}}
    }return true})()`);
};

const t = {
  ev,
  sleep,
  click,
  clickSel: clickSelector,
  type,
  key,
  selectAll,
  settle,
  source,
  rect: (sel) => ev(R(`document.querySelector(${JSON.stringify(sel)})`)),
  rects: (sel) =>
    ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(e=>{const b=e.getBoundingClientRect();
      return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)}})`),
  /** What is really on top at (x,y), and — the assertion that matters for a floating
   *  overlay — whether that element lies inside `withinSel`. */
  hit: (x, y, withinSel) =>
    ev(`(()=>{const e=document.elementFromPoint(${Math.round(x)},${Math.round(y)});
      if(!e)return null;
      return {tag:e.tagName, cls:(e.className||'').toString().slice(0,40),
        inside:${withinSel === undefined ? 'null' : `!!e.closest(${JSON.stringify(withinSel)})`}}})()`),
  teardown,
  clearInput: (sel) => ev(clearControlledInputExpr(sel)),
  async inject() {
    await teardown();
    await sleep(400);
    await inject(ev, source);
    await sleep(500);
  },
  check: () => {},
};

let allPassed = true;
for (let run = 1; run <= opts.repeat; run += 1) {
  const report = createReport();
  t.check = report.check.bind(report);
  try {
    await spec.default(t);
  } catch (err) {
    report.check('spec ran to completion', false, String(err && err.message ? err.message : err));
  }
  const label = opts.repeat > 1 ? `${scriptPath.split('/').pop()} (run ${run}/${opts.repeat})` : scriptPath.split('/').pop();
  if (!report.print(label)) allPassed = false;
}

// Always hand the page back the way we found it — a spec that leaves the script injected
// leaves the operator's tab in a state no install produced.
await teardown();
process.exit(allPassed ? 0 : 1);
