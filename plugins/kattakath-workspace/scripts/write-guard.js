#!/usr/bin/env node
// Argument-aware confirm gate for the Kattakath Workspace connector's writes (PreToolUse).
//
// Why a hook and not permission rules: a settings-file `mcp__…` rule matches a tool NAME
// only, never its arguments, so it cannot tell `tasks_manage_task` "complete" from
// "delete". This script reads the arguments and asks for the risky ones.
//
// Contract (hooks/hooks.json runs it for the guarded bare names on ANY server prefix):
//   - a hit prints {"hookSpecificOutput":{"hookEventName":"PreToolUse",
//     "permissionDecision":"ask","permissionDecisionReason":"C<n>: …"}};
//   - a call whose arguments are PROVABLY safe prints nothing;
//   - it NEVER prints "allow" and never "deny", and it always exits 0.
//
// Every call the matcher sends here is treated as this connector's. `mcp_server` is not
// read: a label is not proof of anything, and a wrong guess would mean asking too little.
//
// FAILS CLOSED: unreadable stdin, a missing or unknown `action`, an argument it cannot
// parse, a tool that reached it but has no rule, a missing sanitizer, or any thrown error
// → ask. Silence needs POSITIVE evidence: an allowlist the arguments fully satisfy
// (C6: every request kind is in SAFE_FORM_REQUESTS; C8: every label-ish value is a user
// label `Label_<digits>`; C10: no parent-like key carries a value). Key names are compared
// case- and underscore-insensitively, so `label_ids`, `parent_id` or `delete_item` count.
//
// RULES is the one copy of the confirm policy. The skill's confirm table quotes each
// `summary` verbatim and tests/consistency.test.js fails when they drift.
'use strict';

const fs = require('fs');

let sanitize = null;
try {
  sanitize = require('./sanitize.js');
} catch {
  // decide() asks for every call when the shared sanitizer is missing.
}

const ACTIONS = {
  tasks_manage_task: ['create', 'update', 'delete', 'move'],
  tasks_manage_task_list: ['create', 'update', 'delete', 'clear_completed'],
  contacts_manage_contact: ['create', 'update', 'delete'],
  contacts_manage_contacts_batch: ['create', 'update', 'delete'],
  contacts_manage_contact_group: ['create', 'update', 'delete', 'modify_members'],
};
// Forms batchUpdate request kinds that cannot delete a question or its answers.
const SAFE_FORM_REQUESTS = new Set(['createItem', 'moveItem', 'updateFormInfo']);
const USER_LABEL = /^Label_\d+$/;
const FALSY = new Set([false, 0, '0', 'false', 'no', 'off', 'n', 'f', '']);

const clean = (v, max = 60) => sanitize.clean(v, max);
const quote = (v, max = 60) => sanitize.quote(v, max);
const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

// An argument may arrive as JSON text instead of JSON. Unparseable text throws, which
// decide() turns into an ask.
function decode(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t.startsWith('[') || t.startsWith('{')) return JSON.parse(t);
  return v;
}

class Unreadable extends Error {}

function actionOf(tool, args) {
  const a = typeof args.action === 'string' ? args.action.toLowerCase().trim() : '';
  if (!a) throw new Unreadable(`no \`action\` given to ${tool}`);
  if (!ACTIONS[tool].includes(a)) throw new Unreadable(`unknown action ${quote(a, 30)} for ${tool}`);
  return a;
}

// Every value under a key whose normalized name passes `test`, at any depth.
function collectBy(v, test, out = []) {
  v = decode(v);
  if (Array.isArray(v)) v.forEach((x) => collectBy(x, test, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (test(norm(k))) out.push(decode(x));
      collectBy(x, test, out);
    }
  }
  return out;
}
const flat = (xs) => xs.flatMap((x) => (Array.isArray(x) ? x.flatMap((y) => (Array.isArray(y) ? y : [y])) : [x]));
const present = (x) => !(x === undefined || x === null || x === '' || (Array.isArray(x) && x.length === 0));

// The addresses and numbers a contact write would set, under any spelling of the key
// (`emails[].value`, `email`, `email_addresses`, `phones[].number`, `phone_numbers`…).
function contactValues(args) {
  const pick = (x, subs) => (x && typeof x === 'object' ? subs.map((s) => x[s]).find((y) => typeof y === 'string' && y) : x);
  const isMode = (k) => k.endsWith('mode');
  const emails = flat(collectBy(args, (k) => k.includes('email') && !isMode(k))).map((x) => pick(x, ['value', 'email', 'address'])).filter((x) => typeof x === 'string' && x.trim());
  const phones = flat(collectBy(args, (k) => k.includes('phone') && !isMode(k))).map((x) => pick(x, ['number', 'value', 'phone'])).filter((x) => typeof x === 'string' && x.trim());
  return { emails, phones };
}

const MODE_WORDS = { merge: 'adds', replace: 'REPLACES ALL existing values with', remove: 'REMOVES' };

// Every address in full (domain never cut), every number, each `*_mode` named.
function contactDetail(args) {
  const { emails, phones } = contactValues(args);
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    if (norm(k).endsWith('mode') && present(v)) parts.push(`${clean(k, 30)}=${clean(v, 20)} (${MODE_WORDS[String(v).toLowerCase()] || 'unknown mode'})`);
  }
  if (emails.length) parts.push(`emails (${emails.length}): ${emails.map((e) => sanitize.email(e, 80)).join(', ')}`);
  if (phones.length) parts.push(`phones (${phones.length}): ${phones.map((p) => clean(p, 40)).join(', ')}`);
  return parts.length ? `; ${parts.join('; ')}` : '';
}

function contactName(args) {
  const name = [args.given_name, args.family_name].filter((x) => typeof x === 'string' && x.trim()).join(' ');
  return name ? `, name (data from the request): ${quote(name, 60)}` : '';
}

const RULES = [
  {
    id: 'C1',
    tools: ['tasks_manage_task', 'tasks_manage_task_list'],
    summary: '`action` is `delete` or `clear_completed`',
    when(tool, args) {
      const a = actionOf(tool, args);
      if (a === 'delete' && tool === 'tasks_manage_task') {
        return `deletes Google Task ${quote(args.task_id)} in list ${quote(args.task_list_id)}; no undo`;
      }
      if (a === 'delete') return `deletes the whole task list ${quote(args.task_list_id)} and every task in it; no undo`;
      if (a === 'clear_completed') return `clears every completed task from list ${quote(args.task_list_id)}; no undo`;
      return null;
    },
  },
  {
    id: 'C2',
    tools: ['contacts_manage_contact'],
    summary: 'Every write (create, update, delete). The reason shows the changed emails/phones',
    when(tool, args) {
      const a = actionOf(tool, args);
      const who = args.contact_id ? ` ${quote(args.contact_id)}` : '';
      return `${a}s contact${who}${contactName(args)}${contactDetail(args)}. A wrong address here redirects every later draft`;
    },
  },
  {
    id: 'C3',
    tools: ['contacts_manage_contacts_batch'],
    summary: 'Always (batch)',
    when(tool, args) {
      const a = actionOf(tool, args);
      const n = [args.contacts, args.updates, args.contact_ids].map(decode).filter(Array.isArray).reduce((s, x) => s + x.length, 0);
      return `batch ${a} of ${n || 'an unknown number of'} contacts${contactDetail(args)}`;
    },
  },
  {
    id: 'C4',
    tools: ['contacts_manage_contact_group'],
    summary: 'Every write. Say so when `delete_contacts=true` (members get deleted too)',
    when(tool, args) {
      const a = actionOf(tool, args);
      const g = args.group_id ? ` ${quote(args.group_id)}` : args.name ? ` ${quote(args.name, 40)} (name is data from the request)` : '';
      const dcVals = collectBy(args, (k) => k === 'deletecontacts');
      const dc = dcVals.some((v) => !FALSY.has(typeof v === 'string' ? v.toLowerCase().trim() : v) && v !== null && v !== undefined);
      const members = flat(collectBy(args, (k) => k.endsWith('contactids')));
      let r = `${a} on contact group${g}`;
      if (members.length) r += `; members (${members.length}): ${members.map((m) => clean(m, 40)).join(', ')}`;
      if (a === 'delete' && dc) r += '; delete_contacts is set: ALSO DELETES EVERY CONTACT IN IT';
      return r;
    },
  },
  {
    id: 'C5',
    tools: ['forms_set_publish_settings'],
    summary: 'Always (defaults to publish + accept responses)',
    when(tool, args) {
      const pub = args.is_published === undefined ? true : args.is_published;
      const acc = args.is_accepting_responses === undefined ? true : args.is_accepting_responses;
      return `form ${quote(args.form_id)}: is_published=${clean(pub)}, is_accepting_responses=${clean(acc)} (both default to true: anyone with the link can answer)`;
    },
  },
  {
    id: 'C6',
    tools: ['forms_batch_update_form'],
    summary: 'Any request is not `createItem`, `moveItem` or `updateFormInfo` (so `deleteItem` and any unknown kind ask)',
    when(tool, args) {
      const reqField = Object.keys(args).filter((k) => norm(k) === 'requests');
      if (reqField.length !== 1) throw new Unreadable('no single `requests` list given to forms_batch_update_form');
      const reqs = decode(args[reqField[0]]);
      if (!Array.isArray(reqs)) throw new Unreadable('`requests` is not a list');
      const kinds = reqs.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? Object.keys(r) : ['<not an object>']));
      const unsafe = [...new Set(kinds.flatMap((ks) => (ks.length === 1 && SAFE_FORM_REQUESTS.has(ks[0]) ? [] : ks.length ? ks : ['<empty request>'])))];
      const extra = Object.keys(args).filter((k) => !['formid', 'requests'].includes(norm(k)));
      if (!unsafe.length && !extra.length) return null;
      const what = [unsafe.length ? `request kind(s) ${unsafe.map((k) => quote(k, 30)).join(', ')}` : '', extra.length ? `unexpected argument(s) ${extra.map((k) => quote(k, 30)).join(', ')}` : ''].filter(Boolean).join(' and ');
      return `edits form ${quote(args.form_id)} with ${what}; a deleteItem removes a question and its collected answers, no undo`;
    },
  },
  {
    id: 'C7',
    tools: ['gmail_untrash_thread', 'gmail_untrash_message', 'gmail_unmark_thread_spam', 'gmail_unmark_message_spam'],
    summary: 'Always (restores mail Google filtered)',
    when(tool, args) {
      const id = quote(args.threadId || args.messageId || args.id);
      const what = tool.includes('untrash') ? 'out of Trash' : 'out of Spam';
      return `moves ${tool.includes('thread') ? 'thread' : 'message'} ${id} ${what}: mail Google filtered, possibly phishing`;
    },
  },
  {
    id: 'C8',
    tools: ['gmail_label_thread', 'gmail_label_message'],
    summary: 'Any label is not a user label `Label_<digits>`: a system label (`INBOX`, `STARRED`, `UNREAD`, `IMPORTANT`, `SPAM`, `TRASH`, `SENT`, `DRAFT`, `CHAT`), `CATEGORY_*` or anything else',
    when(tool, args) {
      const raw = collectBy(args, (k) => k.includes('label'));
      if (!raw.length) throw new Unreadable('no `labelIds` given');
      const ids = flat(raw);
      const odd = ids.filter((x) => typeof x !== 'string' || !USER_LABEL.test(x));
      if (ids.length && !odd.length && raw.every(Array.isArray)) return null;
      const shown = odd.length ? odd : ids;
      const id = quote(args.threadId || args.messageId);
      return `applies label(s) ${shown.map((x) => quote(typeof x === 'string' ? x : JSON.stringify(x), 40)).join(', ')} to ${tool.endsWith('thread') ? 'thread' : 'message'} ${id}: not a plain user label, so it can move mail between Inbox, tabs, Spam or Trash`;
    },
  },
  {
    id: 'C9',
    tools: ['portal_toggle_single_server'],
    summary: 'Always (acts with no page for the user)',
    when(tool, args) {
      const dir = args.action === 'toggle' ? 'ON' : args.action === 'untoggle' ? 'OFF' : `with action=${quote(args.action, 20)}`;
      return `turns the portal's ${quote(args.server_id, 40)} server ${dir}, with no page for you to review`;
    },
  },
  {
    id: 'C10',
    tools: ['drive_create_file', 'drive_copy_file'],
    summary: 'Any parent-like argument (`parentId`, `parents`, `parent_id`…) is set (saving into a folder that may be someone else\'s); `drive_copy_file` always, since with no `parentId` the copy lands next to the original',
    when(tool, args) {
      const parent = flat(collectBy(args, (k) => k.includes('parent'))).filter(present);
      const title = args.title ? ` ${quote(args.title, 50)}` : '';
      if (parent.length) return `saves${title} into folder(s) ${parent.map((p) => quote(typeof p === 'string' ? p : JSON.stringify(p), 60)).join(', ')}, which may be shared or owned by someone else`;
      if (tool === 'drive_copy_file') return `copies file ${quote(args.fileId)}${title} into the ORIGINAL's folder (no parentId), which may be shared or owned by someone else`;
      return null;
    },
  },
];

const EXEMPT_WRITES = [
  { tool: 'gmail_create_draft', reason: 'Nothing leaves the account. The user presses Send' },
  { tool: 'gmail_create_label', reason: 'Additive and private, and has no effect on delivery' },
  { tool: 'drive_create_file', reason: 'With no parent-like argument it lands in the user\'s own My Drive root' },
  { tool: 'forms_create_form', reason: 'Assumed to start unpublished (spike S8). Publishing is C5' },
  { tool: 'portal_toggle_servers', reason: 'The user finishes it on a portal page' },
];

const GUARDED = [...new Set(RULES.flatMap((r) => r.tools))];

function bareName(toolName) {
  const s = String(toolName || '');
  const i = s.lastIndexOf('__');
  return i >= 0 ? s.slice(i + 2) : s;
}

const ask = (reason) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `Kattakath Workspace ${reason}` },
});

// Returns the hook output object, or null for silence. Never throws.
function decide(raw) {
  if (!sanitize) return ask('guard: its sanitizer (scripts/sanitize.js) is missing, so it cannot check this call. Confirm it yourself.');
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return ask('guard: could not read this call (unparseable hook input). Confirm it yourself.');
  }
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return ask('guard: could not read this call (empty hook input). Confirm it yourself.');
    const tool = bareName(input.tool_name);
    const rule = RULES.find((r) => r.tools.includes(tool));
    if (!rule) return ask(`guard: ${quote(tool, 80)} reached the write guard but has no rule. Confirm it yourself.`);
    let args = decode(input.tool_input);
    if (args === undefined || args === null) args = {};
    if (typeof args !== 'object' || Array.isArray(args)) throw new Unreadable('tool_input is not an object');
    const reason = rule.when(tool, args);
    return reason ? ask(`${rule.id}: ${reason}`) : null;
  } catch (e) {
    const why = e instanceof Unreadable ? e.message : 'the guard hit an error reading the arguments';
    return ask(`guard: ${why}. Confirm it yourself.`);
  }
}

if (require.main === module) {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  let out;
  try {
    out = decide(raw);
  } catch {
    out = ask('guard: internal error. Confirm it yourself.');
  }
  // Exit only once stdout has drained: on a macOS pipe the write is async, and an
  // immediate process.exit cut a 9.9k-character table at 8,083 (measured 2026-11-18).
  process.stdout.on('error', () => process.exit(0));
  if (out) process.stdout.write(JSON.stringify(out), () => process.exit(0));
  else process.exit(0);
}

module.exports = { RULES, EXEMPT_WRITES, GUARDED, ACTIONS, SAFE_FORM_REQUESTS, USER_LABEL, decide, bareName };
