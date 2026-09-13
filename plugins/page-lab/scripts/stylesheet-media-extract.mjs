// Pull a site's own narrow-viewport @media blocks out of a stylesheet, and say how much of
// that CSS is the CONTENT surface versus the shell.
//
// This answers survey point M13 — "does the site already ship a compact layout?" — with a
// number instead of an impression. It matters because a site's mobile view is a shipped
// design for "everything except the content": the same judgement a redesign has to make,
// already made, by people who could see the analytics. Replaying the site's own condition
// beats reimplementing it, and ships without a single generated class name.
//
// The split it reports is the decision. If most of the mobile CSS is shell rather than
// grid, adopting the site's compact layout can delete the whole relocation phase; if most
// of it is the grid you were going to replace anyway, adopting buys little.
//
// Brace-matched rather than regex-terminated on purpose: a nested `@supports` or a `}` in a
// string ends the block early under a naive regex, and the rule count then reads low by an
// amount nobody notices.
//
// Usage:
//   stylesheet-media-extract.mjs <url-or-file> [--max-width 1200] [--content <regex>]
//                                              [--json <path>] [--top 18]
//
// Exit: 0 parsed · 2 bad usage · 4 could not fetch or read.

import { readFileSync, writeFileSync } from 'node:fs';

const HELP = `Usage: stylesheet-media-extract.mjs <url-or-file> [options]

  --max-width <px>   treat a query as compact when it caps width at or below this (default 1200)
  --content <regex>  selectors that are the CONTENT surface rather than the shell.
                     Default: grid|gallery|thumb|card|listing|result|item|tile|product
  --top <n>          how many selector roots to tally (default 18)
  --json <path>      write the matched blocks as JSON for a later pass
  -h, --help         this text

Reports, per compact query: rule count, byte count, and the content/shell split.
`;

const die = (msg, code) => {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
};

const argv = process.argv.slice(2);
const o = { src: null, maxWidth: 1200, content: null, top: 18, json: null };
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '-h' || a === '--help') die(HELP, 0);
  else if (a === '--max-width') o.maxWidth = Number(argv[++i]);
  else if (a === '--content') o.content = argv[++i];
  else if (a === '--top') o.top = Number(argv[++i]);
  else if (a === '--json') o.json = argv[++i];
  else if (a.startsWith('--')) die(`unknown option ${a}\n\n${HELP}`, 2);
  else if (o.src === null) o.src = a;
  else die('only one stylesheet may be given', 2);
}
if (o.src === null) die(HELP, 2);
if (!Number.isFinite(o.maxWidth) || o.maxWidth <= 0) die('--max-width needs a positive number', 2);

const CONTENT = new RegExp(
  o.content ?? 'grid|gallery|thumb|card|listing|result|item|tile|product',
  'i',
);

let css;
try {
  css = /^https?:\/\//.test(o.src)
    ? await (await fetch(o.src, { signal: AbortSignal.timeout(30000) })).text()
    : readFileSync(o.src, 'utf8');
} catch (err) {
  die(`stylesheet-media-extract: cannot read ${o.src} — ${err?.message ?? err}`, 4);
}

/** Top-level @media blocks, brace-matched. Nested at-rules do not end the block early. */
function mediaBlocks(text) {
  const out = [];
  const re = /@media([^{]{1,200})\{/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      i += 1;
    }
    out.push({ query: m[1].trim(), body: text.slice(m.index + m[0].length, i - 1) });
    re.lastIndex = i;
  }
  return out;
}

/**
 * A compact query is one that CAPS the width without also flooring it. `min-width` in the
 * same query means the block is a band, not the site's narrow layout, and counting bands as
 * mobile CSS is how this measurement gets inflated into a wrong conclusion.
 */
function isCompact(query, maxWidth) {
  if (/min-width/i.test(query)) return false;
  const caps = [...query.matchAll(/max-width\s*:\s*([\d.]+)(px|em|rem)/gi)].map((m) => {
    const n = Number(m[1]);
    return m[2].toLowerCase() === 'px' ? n : n * 16;
  });
  return caps.length > 0 && Math.min(...caps) <= maxWidth;
}

const all = mediaBlocks(css);
const compact = all.filter((b) => isCompact(b.query, o.maxWidth));

let rules = 0;
let contentRules = 0;
const roots = new Map();
const perQuery = [];
for (const b of compact) {
  const chunks = b.body.split('}').filter((s) => s.includes('{'));
  let own = 0;
  for (const chunk of chunks) {
    // Take the selector after the LAST unclosed `{`, not the first: a chunk that opens a
    // nested at-rule carries `@supports (…){ .card` and reading from the first brace loses
    // the real selector and tallies the at-rule instead.
    let sel = chunk.slice(0, chunk.lastIndexOf('{'));
    const nested = sel.lastIndexOf('{');
    if (nested >= 0) sel = sel.slice(nested + 1);
    sel = sel.trim();
    if (sel === '' || sel.startsWith('@')) continue;
    rules += 1;
    own += 1;
    if (CONTENT.test(sel)) contentRules += 1;
    const root = sel.split(/[\s,>+~]/)[0].slice(0, 32);
    if (root) roots.set(root, (roots.get(root) ?? 0) + 1);
  }
  perQuery.push({ query: b.query, rules: own, bytes: b.body.length });
}

const bytes = compact.reduce((n, b) => n + b.body.length, 0);
const pct = (n) => (rules ? ((n / rules) * 100).toFixed(1) : '0.0');

process.stdout.write(`\nsheet                 ${o.src}\n`);
process.stdout.write(`sheet bytes           ${css.length}\n`);
process.stdout.write(`@media blocks         ${all.length}\n`);
process.stdout.write(`compact (<= ${o.maxWidth}px)   ${compact.length}\n`);
if (compact.length === 0) {
  process.stdout.write(
    '\nNo compact layout in this sheet. Either the site has none (M13 answers "no" — build ' +
      'the relocation yourself), or its narrow layout lives in another sheet or is applied ' +
      'by JS rather than by @media. Check before concluding.\n',
  );
  process.exit(0);
}
process.stdout.write(`rules inside them     ${rules}\n`);
process.stdout.write(`bytes inside them     ${bytes}\n\n`);
process.stdout.write(`  CONTENT surface     ${String(contentRules).padStart(5)}  (${pct(contentRules)}%)\n`);
process.stdout.write(`  the SHELL           ${String(rules - contentRules).padStart(5)}  (${pct(rules - contentRules)}%)\n`);

process.stdout.write('\nper query:\n');
for (const q of perQuery.sort((a, b) => b.rules - a.rules)) {
  process.stdout.write(`  ${String(q.rules).padStart(5)} rules  ${String(q.bytes).padStart(7)}B  @media ${q.query}\n`);
}

process.stdout.write('\ntop selector roots:\n');
for (const [root, n] of [...roots.entries()].sort((a, b) => b[1] - a[1]).slice(0, o.top)) {
  process.stdout.write(`  ${String(n).padStart(4)}  ${root}\n`);
}

process.stdout.write(
  `\nThe decision this feeds: ${pct(rules - contentRules)}% of the site's compact CSS is SHELL — ` +
    'work it has already done that a redesign would otherwise redo. Weigh adopting the ' +
    "site's own condition against reimplementing it (see site-redesign/relocation.md).\n",
);

if (o.json) {
  writeFileSync(o.json, JSON.stringify(compact, null, 1));
  process.stdout.write(`\nwrote ${compact.length} block(s) to ${o.json}\n`);
}
