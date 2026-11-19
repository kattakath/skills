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
//   - a safe call, or a call to ANOTHER server, prints nothing;
//   - it NEVER prints "allow" and never "deny", and it always exits 0.
//
// FAILS CLOSED: unreadable stdin, a missing or unknown `action`, an argument it cannot
// parse, a tool that reached it but has no rule, or any thrown error → ask. Silence needs
// positive evidence: a rule that looked at the arguments and found them safe, or an
// `mcp_server` whose name is readable and is not this connector.
//
// RULES is the one copy of the confirm policy. The skill's confirm table quotes each
// `summary` verbatim and tests/consistency.test.js fails when they drift.
'use strict';

const fs = require('fs');

const CONNECTOR_RE = /kattakathworkspace/;
const SYSTEM_LABELS = new Set(['INBOX', 'STARRED', 'UNREAD', 'IMPORTANT', 'SPAM', 'TRASH', 'SENT', 'DRAFT', 'CHAT']);

const ACTIONS = {
  tasks_manage_task: ['create', 'update', 'delete', 'move'],
  tasks_manage_task_list: ['create', 'update', 'delete', 'clear_completed'],
  contacts_manage_contact: ['create', 'update', 'delete'],
  contacts_manage_contacts_batch: ['create', 'update', 'delete'],
  contacts_manage_contact_group: ['create', 'update', 'delete', 'modify_members'],
};

// One line, no control characters, bounded: these values come from mail and contacts,
// so they are attacker-influenced text shown inside a permission prompt.
function clean(v, max = 60) {
  const s = String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function list(values, max = 5) {
  const xs = values.map((v) => clean(v)).filter(Boolean);
  if (!xs.length) return '';
  return xs.slice(0, max).join(', ') + (xs.length > max ? ` (+${xs.length - max} more)` : '');
}

// An argument may arrive as JSON text instead of JSON. Unparseable text throws, which
// main() turns into an ask.
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
  if (!ACTIONS[tool].includes(a)) throw new Unreadable(`unknown action "${clean(a, 30)}" for ${tool}`);
  return a;
}

// Every value of `key` anywhere under `v` (keys in nested objects and arrays included).
function collect(v, key, out = []) {
  v = decode(v);
  if (Array.isArray(v)) v.forEach((x) => collect(x, key, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === key) out.push(decode(x));
      collect(x, key, out);
    }
  }
  return out;
}

function hasKey(v, key) {
  v = decode(v);
  if (Array.isArray(v)) return v.some((x) => hasKey(x, key));
  if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => k === key || hasKey(x, key));
  return false;
}

// The values a contact write would set: `emails[].value`, `phones[].number|value`, and
// the single `email` / `phone` shorthand fields, at any depth (batch `contacts`/`updates`).
function contactValues(args) {
  const vals = (key, sub) => collect(args, key).flatMap((x) => (Array.isArray(x) ? x : [x]))
    .map((x) => (x && typeof x === 'object' ? sub.map((s) => x[s]).find(Boolean) : x)).filter(Boolean);
  return {
    emails: [...vals('emails', ['value', 'email', 'address']), ...vals('email', ['value'])],
    phones: [...vals('phones', ['number', 'value', 'phone']), ...vals('phone', ['value'])],
  };
}

function contactDetail(args) {
  const { emails, phones } = contactValues(args);
  const parts = [];
  if (emails.length) parts.push(`emails: ${list(emails)}`);
  if (phones.length) parts.push(`phones: ${list(phones)}`);
  return parts.length ? `; ${parts.join('; ')}` : '';
}

const RULES = [
  {
    id: 'C1',
    tools: ['tasks_manage_task', 'tasks_manage_task_list'],
    summary: '`action` is `delete` or `clear_completed`',
    when(tool, args) {
      const a = actionOf(tool, args);
      if (a === 'delete' && tool === 'tasks_manage_task') {
        return `deletes Google Task ${clean(args.task_id)} in list ${clean(args.task_list_id)}; no undo`;
      }
      if (a === 'delete') return `deletes the whole task list ${clean(args.task_list_id)} and every task in it; no undo`;
      if (a === 'clear_completed') return `clears every completed task from list ${clean(args.task_list_id)}; no undo`;
      return null;
    },
  },
  {
    id: 'C2',
    tools: ['contacts_manage_contact'],
    summary: 'Every write (create, update, delete). The reason shows the changed emails/phones',
    when(tool, args) {
      const a = actionOf(tool, args);
      const who = args.contact_id ? ` ${clean(args.contact_id)}` : '';
      const name = [args.given_name, args.family_name].filter(Boolean).map((x) => clean(x, 40)).join(' ');
      return `${a}s contact${who}${name ? ` (${name})` : ''}${contactDetail(args)}. A wrong address here redirects every later draft`;
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
      const g = args.group_id ? ` ${clean(args.group_id)}` : args.name ? ` "${clean(args.name, 40)}"` : '';
      const dc = args.delete_contacts === true || String(args.delete_contacts).toLowerCase() === 'true';
      const members = [...collect(args, 'add_contact_ids'), ...collect(args, 'remove_contact_ids')].flat();
      let r = `${a} on contact group${g}`;
      if (members.length) r += `; members: ${list(members)}`;
      if (a === 'delete' && dc) r += '; delete_contacts=true ALSO DELETES EVERY CONTACT IN IT';
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
      return `form ${clean(args.form_id)}: is_published=${clean(pub)}, is_accepting_responses=${clean(acc)} (both default to true: anyone with the link can answer)`;
    },
  },
  {
    id: 'C6',
    tools: ['forms_batch_update_form'],
    summary: 'Any request contains `deleteItem`',
    when(tool, args) {
      if (args.requests === undefined || args.requests === null) throw new Unreadable('no `requests` given to forms_batch_update_form');
      const reqs = decode(args.requests);
      if (!Array.isArray(reqs) && (typeof reqs !== 'object' || reqs === null)) throw new Unreadable('`requests` is not a list');
      return hasKey(reqs, 'deleteItem') ? `deletes question(s) from form ${clean(args.form_id)}, with their collected answers; no undo` : null;
    },
  },
  {
    id: 'C7',
    tools: ['gmail_untrash_thread', 'gmail_untrash_message', 'gmail_unmark_thread_spam', 'gmail_unmark_message_spam'],
    summary: 'Always (restores mail Google filtered)',
    when(tool, args) {
      const id = clean(args.threadId || args.messageId || args.id);
      const what = tool.includes('untrash') ? 'out of Trash' : 'out of Spam';
      return `moves ${tool.includes('thread') ? 'thread' : 'message'} ${id} ${what}: mail Google filtered, possibly phishing`;
    },
  },
  {
    id: 'C8',
    tools: ['gmail_label_thread', 'gmail_label_message'],
    summary: '`labelIds` has a system label (`INBOX`, `STARRED`, `UNREAD`, `IMPORTANT`, `SPAM`, `TRASH`, `SENT`, `DRAFT`, `CHAT`) or `CATEGORY_*`',
    when(tool, args) {
      const ids = collect(args, 'labelIds').flatMap((x) => (Array.isArray(x) ? x : [x]));
      if (!ids.length) throw new Unreadable('no `labelIds` given');
      const sys = ids.filter((x) => typeof x !== 'string' || SYSTEM_LABELS.has(x.toUpperCase()) || /^CATEGORY_/i.test(x));
      if (!sys.length) return null;
      const id = clean(args.threadId || args.messageId);
      return `applies system label(s) ${list(sys)} to ${tool.endsWith('thread') ? 'thread' : 'message'} ${id}: moves mail between Inbox, tabs, Spam or Trash`;
    },
  },
  {
    id: 'C9',
    tools: ['portal_toggle_single_server'],
    summary: 'Always (acts with no page for the user)',
    when(tool, args) {
      const dir = args.action === 'toggle' ? 'ON' : args.action === 'untoggle' ? 'OFF' : `with action="${clean(args.action, 20)}"`;
      return `turns the portal's "${clean(args.server_id, 40)}" server ${dir}, with no page for you to review`;
    },
  },
  {
    id: 'C10',
    tools: ['drive_create_file', 'drive_copy_file'],
    summary: '`parentId` is set (saving into a folder that may be someone else\'s); `drive_copy_file` always, since with no `parentId` the copy lands next to the original',
    when(tool, args) {
      const parent = [args.parentId, ...[].concat(decode(args.parents) || [])].filter((x) => x !== undefined && x !== null && String(x).trim() !== '');
      const title = args.title ? ` "${clean(args.title, 50)}"` : '';
      if (parent.length) return `saves${title} into folder ${list(parent)}, which may be shared or owned by someone else`;
      if (tool === 'drive_copy_file') return `copies file ${clean(args.fileId)}${title} into the ORIGINAL's folder (no parentId), which may be shared or owned by someone else`;
      return null;
    },
  },
];

const EXEMPT_WRITES = [
  { tool: 'gmail_create_draft', reason: 'Nothing leaves the account. The user presses Send' },
  { tool: 'gmail_create_label', reason: 'Additive and private, and has no effect on delivery' },
  { tool: 'drive_create_file', reason: 'With no `parentId` it lands in the user\'s own My Drive root' },
  { tool: 'forms_create_form', reason: 'Assumed to start unpublished (spike S8). Publishing is C5' },
  { tool: 'portal_toggle_servers', reason: 'The user finishes it on a portal page' },
];

const GUARDED = [...new Set(RULES.flatMap((r) => r.tools))];

function bareName(toolName) {
  const s = String(toolName || '');
  const i = s.lastIndexOf('__');
  return i >= 0 ? s.slice(i + 2) : s;
}

// true: this connector (or unknown, which counts as this connector); false: another server.
function isOurs(input) {
  if (!('mcp_server' in input) || input.mcp_server === undefined || input.mcp_server === null) return true;
  const m = input.mcp_server;
  const names = typeof m === 'string' ? [m] : typeof m === 'object' ? [m.name, m.label, m.server_name, m.serverName].filter((x) => typeof x === 'string' && x.trim()) : [];
  if (!names.length) return true;
  return names.some((n) => CONNECTOR_RE.test(n.toLowerCase().replace(/[^a-z0-9]/g, '')));
}

const ask = (reason) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `Kattakath Workspace ${reason}` },
});

// Returns the hook output object, or null for silence. Never throws.
function decide(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return ask('guard: could not read this call (unparseable hook input). Confirm it yourself.');
  }
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return ask('guard: could not read this call (empty hook input). Confirm it yourself.');
    if (!isOurs(input)) return null;
    const tool = bareName(input.tool_name);
    const rule = RULES.find((r) => r.tools.includes(tool));
    if (!rule) return ask(`guard: ${clean(tool, 80) || 'this tool'} reached the write guard but has no rule. Confirm it yourself.`);
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

module.exports = { RULES, EXEMPT_WRITES, GUARDED, ACTIONS, SYSTEM_LABELS, decide, bareName, isOurs, clean };
