// Verify a site redesign the way it actually runs: at document-start, across real
// navigations, with trusted events.
//
// The difference from userscript-acceptance.mjs is not the assertions — it is the WORLD
// they run in. That runner evaluates a spec against a page that is already loaded, which is
// right for a single-element change and wrong for a redesign: the installed script runs at
// `@run-at document-start`, before the site's own JS, and the site's JS then runs after it
// and may overwrite what it did. A suite built the other way round reported 88 checks and
// 0 failures on a build that, once installed, themed four of six page shapes, rendered one
// gallery blank, and opened a 55x5132px drawer [F-INJECT-IS-NOT-INSTALL].
//
// So the correct thing is the default here and costs nothing: a fresh target (never a
// long-lived shared one [F-INPUT-SILENTLY-DROPPED]), opened in the BACKGROUND with focus
// emulation on rather than activated — that keeps the clock live without taking over the
// operator's window [F-FOCUS-EMULATION] — one real navigation per URL shape, and the script
// registered through Page.addScriptToEvaluateOnNewDocument, which does NOT touch the
// document already open, only the next navigation [F-DOCSTART-NEXT-NAV].
//
// A new site is a CONFIG, not a program. See redesign.config.example.mjs.
//
// Exit: 0 every check passed · 1 at least one failed · 2 bad usage · 3 no browser or no
// target · 7 this Node cannot speak WebSocket.

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createReport, openLab, settle, userScriptBody } from './lib/harness.mjs';
import {
  GROUP_ORDER,
  GROUPS,
  STOCK_SAFE_GROUPS,
  classify,
  hintFor,
  identityExpr,
  missingConfig,
  probeExpr,
} from './lib/redesign-checks.mjs';

const HELP = `Usage: redesign-acceptance.mjs [options] <config.mjs>

  --diagnose            one line per URL shape with the decision-relevant facts, no verdicts.
                        Start here when something is wrong: it is the mode that found five
                        live defects in minutes after 88 injected checks found none.
  --groups a,b,c        run only these groups (default: the config's \`groups\`)
  --shape <label>       run only this shape
  --stock               measure WITHOUT injecting — the baseline every comparison needs
  --script <path>       the .user.js under test (default: the config's \`script\`)
  --browser-url <url>   debug browser. REQUIRED — or set PL_BROWSER_URL. There is no
                        default, on purpose: the conventional :9222 is usually the operator's
                        OWN browser, which has the script INSTALLED, so a run that silently
                        lands there measures a different build and reports its own staleness
                        as defects [F-RAN-AGAINST-THE-OPERATORS-BROWSER].
  --keep-open           leave the lab target open for inspection
  -h, --help            this text

Groups (each opt-in, each skips loudly when its config is absent):
${GROUP_ORDER.map((g) => `  ${g.padEnd(15)} ${GROUPS[g].why}`).join('\n')}
`;

const die = (msg, code) => {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
};

function parseArgs(argv) {
  const o = { browserUrl: process.env.PL_BROWSER_URL || null, config: null, groups: null, shape: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--diagnose') o.diagnose = true;
    else if (a === '--stock') o.stock = true;
    else if (a === '--keep-open') o.keepOpen = true;
    else if (a === '--browser-url') o.browserUrl = argv[++i];
    else if (a === '--script') o.script = argv[++i];
    else if (a === '--shape') o.shape = argv[++i];
    else if (a === '--groups') o.groups = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (o.config === null) o.config = a;
    else throw new Error('only one config may be given');
  }
  return o;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  die(`redesign-acceptance: ${err.message}\n\n${HELP}`, 2);
}
if (opts.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (opts.config === null) die(HELP, 2);

const configPath = resolve(opts.config);
const mod = await import(pathToFileURL(configPath).href);
const cfg = mod.default ?? mod.config;
if (typeof cfg !== 'object' || cfg === null) die(`${opts.config}: must default-export a config object`, 2);
if (typeof cfg.origin !== 'string' || !/^https?:\/\//.test(cfg.origin)) {
  die(`${opts.config}: \`origin\` must be a http(s) origin`, 2);
}
if (!Array.isArray(cfg.shapes) || cfg.shapes.length === 0) {
  die(`${opts.config}: \`shapes\` must list at least one URL shape`, 2);
}

// The own-UI selector is derived once, from the prefix, so a config cannot declare the two
// inconsistently: the theme audit's exclusion list and the "is this ours?" test must agree.
if (!cfg.ownUiSelector && cfg.ownUiPrefix) cfg.ownUiSelector = `[class*="${cfg.ownUiPrefix}"]`;

const scriptRel = opts.script ?? cfg.script;
let source = '';
if (!opts.stock) {
  if (typeof scriptRel !== 'string') die(`${opts.config}: no script — pass --script or set \`script\``, 2);
  const scriptPath = isAbsolute(scriptRel) ? scriptRel : resolve(configPath, '..', scriptRel);
  source = userScriptBody(readFileSync(scriptPath, 'utf8'));
}

const shapes = cfg.shapes
  .map((s, i) => ({
    label: s.label ?? s.path ?? `shape-${i + 1}`,
    url: s.url ?? (s.path ? cfg.origin.replace(/\/+$/, '') + s.path : null),
    organic: s.organic,
    expect: s.expect ?? 'applied',
    discover: s.discover,
  }))
  .filter((s) => opts.shape === null || s.label === opts.shape);
if (shapes.length === 0) die(`no shape labelled ${JSON.stringify(opts.shape)}`, 2);

/**
 * Refuse rather than default. This runner performs REAL navigations, so the browser it lands
 * in matters as much as the script it injects, and the conventional debug port is the
 * operator's own window: their tabs, their extensions, and a userscript manager holding an
 * INSTALLED copy of the very script under test. A run that defaulted there navigated four
 * shapes in the operator's browser and returned eight confident failures, every one of them
 * the difference between the installed build and the one on disk
 * [F-RAN-AGAINST-THE-OPERATORS-BROWSER]. Refusing costs one flag; guessing costs a diagnosis.
 */
if (!opts.browserUrl) {
  die(
    'redesign-acceptance: no browser given. Pass --browser-url <url> or set PL_BROWSER_URL.\n' +
      'There is deliberately no default: :9222 is usually the operator\'s own browser, where an\n' +
      'INSTALLED copy of the script measures instead of the one on disk. Use a throwaway browser\n' +
      '(a separate --remote-debugging-port with its own --user-data-dir).',
    2,
  );
}

let lab;
try {
  lab = await openLab({ browserUrl: opts.browserUrl });
} catch (err) {
  die(`redesign-acceptance: ${err.message}`, err.exitCode ?? 3);
}

/** Wait for the shape to stop changing, rather than sleeping at it [F-TRANSITION-RACE]. */
const probeSettled = () =>
  settle(() => lab.ev(probeExpr(cfg)), {
    tries: cfg.settle?.tries ?? 30,
    gap: cfg.settle?.gap ?? 200,
    stableFor: cfg.settle?.stableFor ?? 3,
  });

/**
 * Resolve a shape that is reached by FOLLOWING a link rather than by a known path — a
 * detail page, a profile, a channel. The redesign has to survive those shapes too, and
 * hard-coding one URL into a config makes it rot on the site's next content rotation.
 */
async function resolveUrl(shape) {
  if (!shape.discover) return shape.url;
  const from = cfg.origin.replace(/\/+$/, '') + shape.discover.from;
  await lab.navigate(from);
  await probeSettled();
  const href = await lab.ev(`(()=>{const a=document.querySelector(${JSON.stringify(shape.discover.linkSelector)});
    return a?a.href:''})()`);
  return href || null;
}

let docStartId = null;
if (!opts.stock) docStartId = await lab.addDocStart(source);

/**
 * The document-start registration, as something a group can take away and put back.
 *
 * `stock-identity` needs a genuine STOCK arm — the same URL loaded with nothing injected —
 * and the only honest way to get one is to remove the registration and navigate again. It
 * does not affect the document already open [F-DOCSTART-NEXT-NAV], which is exactly why the
 * navigation is the load-bearing half.
 */
const script = {
  get injected() {
    return docStartId !== null;
  },
  async detach() {
    if (docStartId === null) return;
    await lab.removeDocStart(docStartId);
    docStartId = null;
  },
  async attach() {
    if (docStartId !== null || opts.stock || !source) return;
    docStartId = await lab.addDocStart(source);
  },
};

/**
 * PREFLIGHT — is there an INSTALLED copy of this script in the browser we just attached to?
 *
 * Every measurement below assumes exactly one copy of the redesign is running: the one on
 * disk, registered at document-start. A userscript manager holding an installed copy breaks
 * that assumption twice over. The installed build is whatever the operator last clicked
 * through, so it is routinely OLDER than the file under test — and the run then reports the
 * gap between the two as defects in the file. It also races a second copy against the first,
 * which is the two-copy livelock the teardown contract exists for, arriving here as noise
 * rather than as the finding it is.
 *
 * The test is one navigation with NOTHING injected: the root flag must be absent. It is
 * cheap, it uses config the suite already has, and it is the check that would have turned
 * eight confident failures into one accurate line [F-RAN-AGAINST-THE-OPERATORS-BROWSER].
 */
if (cfg.rootFlag && shapes[0]?.url) {
  const wasInjected = script.injected;
  await script.detach();
  await lab.navigate(shapes[0].url);
  await probeSettled();
  const installed = await lab.ev(
    `document.documentElement.hasAttribute(${JSON.stringify(cfg.rootFlag)})`,
  );
  if (installed) {
    die(
      `redesign-acceptance: an INSTALLED copy of this script is running in that browser.\n` +
        `  ${shapes[0].url} came back carrying ${cfg.rootFlag} with nothing injected.\n` +
        `Every verdict below would compare the file on disk against whatever build is installed —\n` +
        `usually an older one — and report the difference as defects. Use a throwaway browser with\n` +
        `its own --user-data-dir and no userscript manager.`,
      3,
    );
  }
  if (wasInjected) await script.attach();
}

// ---------------------------------------------------------------------------------------
// --diagnose: facts per shape, and what to look at next. No verdicts.
// ---------------------------------------------------------------------------------------
if (opts.diagnose) {
  const rows = [];
  for (const shape of shapes) {
    const url = await resolveUrl(shape);
    if (url === null) {
      rows.push({ shape, p: null, err: [`could not discover a URL via ${shape.discover.linkSelector}`] });
      continue;
    }
    await lab.navigate(url);
    let p = null;
    let err = [...lab.errors];
    try {
      p = await probeSettled();
    } catch (e) {
      err = [...err, String(e.message ?? e)];
    }
    rows.push({ shape, p, err, url });
  }

  // A table nobody can scan is a table nobody reads: size every column to its content.
  const cells = rows.map(({ shape, p, err }) => {
    if (p === null) return [shape.label, 'UNREACHABLE', '-', '-', '-', '-', '-', '-', '-'];
    const ctrl = Object.entries(p.controls);
    return [
      shape.label,
      classify(p),
      p.themed === null ? '-' : p.themed ? 'yes' : 'NO',
      String(p.gridOn ?? (p.gridFound ? '-' : 'NONE')),
      `${p.unitsVisible}/${p.units}`,
      p.strays === null ? '-' : String(p.strays),
      String(p.overflow),
      ctrl.length ? ctrl.map(([n, c]) => `${n}:${c}`).join(' ') : '-',
      String(err.length),
    ];
  });
  const head = ['shape', 'mode', 'theme', 'grid', 'units', 'stray', 'ovf', 'controls', 'err'];
  const w = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c) => `${c.map((v, i) => v.padEnd(w[i])).join('  ')}\n`.replace(/\s+$/, '\n');
  process.stdout.write(`\n${line(head)}${line(w.map((n) => '-'.repeat(n)))}`);
  for (const c of cells) process.stdout.write(line(c));

  process.stdout.write('\n');
  for (const { shape, p, err } of rows) {
    const hints = p ? hintFor(p, cfg) : [];
    if (hints.length === 0 && err.length === 0) continue;
    process.stdout.write(`${shape.label}:\n`);
    for (const h of hints) process.stdout.write(`  → ${h}\n`);
    for (const e of err.slice(0, 3)) process.stdout.write(`  ! ${e.split('\n')[0].slice(0, 160)}\n`);
  }
  if (rows.every((r) => r.p && hintFor(r.p, cfg).length === 0 && r.err.length === 0)) {
    process.stdout.write('every shape is clean.\n');
  }
  process.stdout.write(
    `\nmeasured at document-start via addScriptToEvaluateOnNewDocument on ${rows.length} real ` +
      `navigation(s)${opts.stock ? ', WITHOUT injection (--stock baseline)' : ''}.\n`,
  );
  if (!opts.keepOpen) await lab.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------------------
const wanted = opts.groups ?? cfg.groups ?? GROUP_ORDER;
const unknown = wanted.filter((g) => !GROUPS[g]);
if (unknown.length) die(`unknown group(s): ${unknown.join(', ')}\n\n${HELP}`, 2);
const order = GROUP_ORDER.filter((g) => wanted.includes(g));

const report = createReport();
const skipped = [];
for (const g of order) {
  const miss = missingConfig(cfg, GROUPS[g].needs);
  if (miss) skipped.push(`${g} (no \`${miss}\` in the config)`);
}
const runnable = order.filter((g) => missingConfig(cfg, GROUPS[g].needs) === null);
const primary = shapes[0];

// `rig` first and deliberately: a target that has stopped delivering trusted press/release
// makes every working control read as dead, so its verdict invalidates the rest rather than
// competing with it [F-INPUT-SILENTLY-DROPPED].
const onceGroups = runnable.filter((g) => GROUPS[g].scope === 'once');
const shapeGroups = runnable.filter((g) => GROUPS[g].scope === 'shape');

const runGroup = async (name, shape, probe) => {
  // Most assertions are prefixed with the shape they ran on. A group that visits OTHER
  // shapes (stock-identity) labels its own, or every line would read as the primary shape.
  const prefix = GROUPS[name].labelled === false ? '' : `[${shape.label}] `;
  const t = (n, pass, detail) => report.check(`${prefix}${n}`, pass, detail);
  try {
    await GROUPS[name].run({ lab, cfg, shape, probe, t, source, script, note: () => {} });
  } catch (err) {
    t(`group "${name}" ran to completion`, false, String(err?.message ?? err));
  }
};

for (const shape of shapes) {
  const url = await resolveUrl(shape);
  if (url === null) {
    report.check(`[${shape.label}] reachable`, false, `discover selector matched nothing`);
    continue;
  }
  shape.url = url;
  await lab.navigate(url);
  let probe;
  try {
    probe = await probeSettled();
  } catch (err) {
    report.check(`[${shape.label}] page is measurable`, false, String(err?.message ?? err));
    continue;
  }
  if (lab.errors.length) {
    report.check(`[${shape.label}] no page-side exceptions`, false, lab.errors.slice(0, 2));
  }
  if (shape === primary && onceGroups.includes('rig')) await runGroup('rig', shape, probe);

  // A shape declared `expect: 'stock'` is one the gate is SUPPOSED to decline — the
  // zero-organic shape, a lookalike that must not qualify. Running "did the redesign apply"
  // against it turns a correct refusal into eight failures and buries the one assertion that
  // matters, so assert the refusal instead and skip the rest, loudly.
  if (shape.expect === 'stock') {
    const ident = await lab.ev(identityExpr(cfg));
    report.check(
      `[${shape.label}] declared expect:'stock' — the redesign declined this shape`,
      ident.rootFlag === false && ident.own === 0,
      {
        rootFlag: ident.rootFlag,
        ownNodes: ident.own,
        next:
          ident.rootFlag || ident.own
            ? 'the gate accepted a shape the config says it must refuse — widen the gate test, ' +
              "or drop expect:'stock' if the shape really is in scope"
            : undefined,
      },
    );
    const ran = shapeGroups.filter((g) => STOCK_SAFE_GROUPS.has(g));
    for (const g of ran) await runGroup(g, shape, probe);
    const skippedHere = shapeGroups.filter((g) => !STOCK_SAFE_GROUPS.has(g));
    if (skippedHere.length) {
      process.stdout.write(
        `\n[${shape.label}] expect:'stock' — skipped ${skippedHere.length} in-scope group(s): ` +
          `${skippedHere.join(', ')}\n`,
      );
    }
    continue;
  }

  for (const g of shapeGroups) await runGroup(g, shape, probe);
}

// The `once` groups mutate page state (they open drawers, navigate, tear the script down and
// break its anchor on purpose), so they run last, on a freshly navigated primary shape.
for (const g of onceGroups.filter((n) => n !== 'rig')) {
  await lab.navigate(primary.url);
  let probe;
  try {
    probe = await probeSettled();
  } catch (err) {
    report.check(`[${primary.label}] page is measurable for "${g}"`, false, String(err?.message ?? err));
    continue;
  }
  await runGroup(g, primary, probe);
}

const ok = report.print(
  `${cfg.name ?? 'redesign'} — ${shapes.length} shape(s), document-start, trusted events`,
);
if (skipped.length) {
  process.stdout.write(`\nSKIPPED (config absent, NOT passed):\n${skipped.map((s) => `  - ${s}`).join('\n')}\n`);
}
if (!opts.keepOpen) {
  await script.detach();
  await lab.close();
}
process.exit(ok ? 0 : 1);
