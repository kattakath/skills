// The ONE text sanitizer for both hook scripts (write-guard.js, corpus-locator.js).
//
// Everything it cleans is attacker-influenced: contact names and addresses, mail subjects,
// file names and invite titles, shown inside a permission prompt or a locator table. So it:
//   - normalizes to NFKC, then strips C0/C1 controls (terminal escapes included), the line
//     and paragraph separators, bidi controls (U+202A-202E, U+2066-2069, U+200E/200F) and
//     zero-width characters (U+200B-200D, U+2060-2065, U+FEFF);
//   - collapses whitespace to one line;
//   - neutralizes the characters that build markdown tables, code spans and links.
// `email()` cuts from the LEFT of the local part, never the domain, so the domain a write
// sends mail to is always shown in full.
'use strict';

// Written as escapes on purpose: a raw U+2028 inside a regex literal is a line terminator.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

function base(v) {
  let s = v === undefined || v === null ? '' : String(v);
  try {
    s = s.normalize('NFKC');
  } catch {
    // keep the raw string; the strip below still runs
  }
  return s.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
}

// One bounded line, safe inside a markdown table cell or a prompt sentence.
function clean(v, max = 80) {
  const s = base(v).replace(/\|/g, '/').replace(/`/g, "'");
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Free text quoted as data: double quotes inside become single quotes, so the closing
// quote is always ours.
function quote(v, max = 80) {
  return `"${clean(v, max).replace(/"/g, "'")}"`;
}

// An address, cut from the left of the local part when long; the domain is never cut.
function email(v, max = 80) {
  const s = clean(v, 10000);
  const at = s.lastIndexOf('@');
  if (s.length <= max) return s;
  if (at < 0) return '…' + s.slice(-(max - 1));
  const domain = s.slice(at);
  const keep = Math.max(0, max - domain.length - 1);
  return '…' + s.slice(at - keep, at) + domain;
}

module.exports = { clean, quote, email, INVISIBLE };
