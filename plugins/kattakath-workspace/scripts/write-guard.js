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
// label `Label_<digits>`; C10: no parent-like key carries a value). C11-C17 never go
// silent: they always ask, and exist to make the reason precise. Key names are compared
// case- and underscore-insensitively, so `label_ids`, `parent_id` or `delete_item` count.
//
// RULES is the one copy of the confirm policy. The skill's confirm table quotes each
// `summary` verbatim, GUARDED (its tools) is generated into references/guarded.json for
// nix-config's mcp-portal-posture gate, and tests/consistency.test.js fails on any drift.
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


// ---- helpers for C11-C17 (the tools enabled 2026-11-19, operator: ALL, GUARDED) ----
// These rules ALWAYS ask; their job is a precise reason. Every value in it is data from
// the request, sanitized. Fields are read from the TOP LEVEL only (any key spelling): a
// value nested somewhere else must never stand in for the one Google acts on. Schemas:
// developers.google.com tool pages, and for the Gmail tools without one, the tool list
// Cloudflare synced from Google's server (read 2026-11-19).

// Every top-level value whose normalized key is in `names`.
const topVals = (args, names) => Object.entries(args).filter(([k]) => names.includes(norm(k))).map(([, v]) => decode(v)).filter(present);

// One id, or every distinct value when several spellings disagree.
function idOf(args, names) {
  const vals = [...new Set(topVals(args, names).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))))];
  if (!vals.length) return '(no id given)';
  if (vals.length === 1) return quote(vals[0]);
  return `CONFLICTING ids ${vals.map((v) => quote(v, 40)).join(' / ')}`;
}
const oneVal = (args, names) => {
  const vals = topVals(args, names);
  return vals.length ? vals[0] : undefined;
};
const labelList = (xs) => xs.map((x) => quote(typeof x === 'string' ? x : JSON.stringify(x), 40)).join(', ');

// Attendee entries under top-level attendee-like keys: their addresses, and a count of the
// entries with no readable address (an Attendee may carry only an `id`).
function attendeesOf(args, removing) {
  const keys = Object.keys(args).filter((k) => norm(k).includes('attendee') && norm(k).includes('remove') === removing);
  const entries = flat(keys.map((k) => decode(args[k])));
  const addr = (x) => (x && typeof x === 'object' ? x.email || x.emailAddress : x);
  const list = entries.map(addr).filter((x) => typeof x === 'string' && x.trim());
  return { list: [...new Set(list)], unreadable: entries.length - list.length };
}
function attendeeText(verb, a) {
  const parts = [];
  if (a.list.length) parts.push(`${verb} ${a.list.length}: ${a.list.map((e) => sanitize.email(e, 80)).join(', ')}`);
  if (a.unreadable) parts.push(`${a.unreadable} attendee entr${a.unreadable === 1 ? 'y' : 'ies'} with no readable address`);
  return parts.join('; ');
}

// notificationLevel defaults to ALL upstream, so only an explicit NONE means silence.
function notifyOf(args) {
  const vals = collectBy(args, (k) => k === 'notificationlevel' || k === 'sendupdates').filter(present);
  const v = vals.length === 1 && typeof vals[0] === 'string' ? vals[0].toUpperCase().trim() : vals.length ? 'CONFLICTING' : 'ALL';
  if (v === 'NONE') return 'nobody is emailed (notificationLevel=NONE)';
  if (v === 'EXTERNAL_ONLY' || v === 'EXTERNALONLY') return 'Google emails EXTERNAL attendees only';
  if (v === 'ALL') return `Google emails every attendee (notificationLevel=${vals.length ? 'ALL' : 'unset, default ALL'})`;
  return `Google may email attendees (notificationLevel=${clean(v, 30)})`;
}

// The kinds of a top-level batchUpdate-style `requests` list ({insertText: …} → insertText).
function requestKinds(args) {
  const field = Object.keys(args).filter((k) => norm(k) === 'requests');
  if (field.length !== 1) throw new Unreadable('no single `requests` list given');
  const reqs = decode(args[field[0]]);
  if (!Array.isArray(reqs)) throw new Unreadable('`requests` is not a list');
  const kinds = reqs.flatMap((r) => (r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length ? Object.keys(r) : ['<not a request>']));
  const counts = {};
  for (const k of kinds) counts[k] = (counts[k] || 0) + 1;
  const shown = Object.entries(counts).map(([k, n]) => `${clean(k, 40)}${n > 1 ? ` x${n}` : ''}`);
  const del = kinds.filter((k) => /delete|remove|clear|reject|accept|replaceall/i.test(k));
  return `${reqs.length} request(s): ${shown.join(', ')}${del.length ? `; includes ${[...new Set(del)].map((k) => clean(k, 40)).join(', ')}, which delete, replace or settle content` : ''}`;
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
    summary: 'Any request is not `createItem`, `moveItem` or `updateFormInfo`',
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
    summary: 'Any label is not a user label `Label_<digits>` (a system or `CATEGORY_*` label moves mail)',
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
    summary: 'A parent-like argument (`parentId`, `parents`…) is set; `drive_copy_file` always (lands beside the original)',
    when(tool, args) {
      const parent = flat(collectBy(args, (k) => k.includes('parent'))).filter(present);
      const title = args.title ? ` ${quote(args.title, 50)}` : '';
      const shown = (p) => {
        const q = quote(typeof p === 'string' ? p : JSON.stringify(p), 60);
        return q === '""' ? '(a blank value)' : q;
      };
      if (parent.length) return `saves${title} into folder(s) ${parent.map(shown).join(', ')}, which may be shared or owned by someone else`;
      if (tool === 'drive_copy_file') return `copies file ${quote(args.fileId)}${title} into the ORIGINAL's folder (no parentId), which may be shared or owned by someone else`;
      return null;
    },
  },
  {
    id: 'C11',
    tools: ['gmail_trash_thread', 'gmail_trash_message', 'gmail_mark_thread_spam', 'gmail_mark_message_spam', 'gmail_apply_sensitive_thread_label', 'gmail_apply_sensitive_message_label'],
    summary: 'Always (to Trash or Spam)',
    when(tool, args) {
      const kind = tool.includes('thread') ? 'thread' : 'message';
      const id = idOf(args, kind === 'thread' ? ['threadid'] : ['messageid']);
      let to = tool.includes('trash') ? 'TRASH' : 'SPAM';
      if (tool.includes('sensitive')) {
        const opt = topVals(args, ['labeloption']).map((v) => String(v).toUpperCase().trim());
        to = opt.length === 1 && ['TRASH', 'SPAM'].includes(opt[0]) ? opt[0] : `labelOption=${opt.length ? opt.map((o) => clean(o, 30)).join('/') : 'unset'}`;
      }
      if (to === 'TRASH') return `moves ${kind} ${id} to Trash: it leaves the Inbox and Gmail deletes it for good after 30 days`;
      if (to === 'SPAM') return `marks ${kind} ${id} as spam: it leaves the Inbox, and Gmail learns to filter mail like it`;
      return `applies a sensitive label to ${kind} ${id} with ${to} (Trash or Spam expected)`;
    },
  },
  {
    id: 'C12',
    tools: ['gmail_unlabel_thread', 'gmail_unlabel_message', 'gmail_update_message_labels'],
    summary: 'Always; names labels added and removed',
    when(tool, args) {
      const kind = tool.includes('thread') ? 'thread' : 'message';
      const id = idOf(args, kind === 'thread' ? ['threadid'] : ['messageid']);
      const added = tool.includes('unlabel') ? [] : flat(topVals(args, ['addlabelids']));
      const removed = flat(topVals(args, tool.includes('unlabel') ? ['labelids'] : ['removelabelids']));
      const known = tool.includes('unlabel') ? ['threadid', 'messageid', 'labelids'] : ['messageid', 'addlabelids', 'removelabelids'];
      const extra = Object.keys(args).filter((k) => !known.includes(norm(k)));
      const parts = [];
      if (added.length) parts.push(`adds ${labelList(added)}`);
      if (removed.length) parts.push(`removes ${labelList(removed)}`);
      if (!parts.length) parts.push('no label ids given');
      if (extra.length) parts.push(`unexpected argument(s) ${extra.map((k) => quote(k, 30)).join(', ')}`);
      const hides = removed.some((l) => ['INBOX', 'UNREAD'].includes(String(l).toUpperCase())) ? '; removing INBOX or UNREAD hides it from the Inbox or the unread count' : '';
      return `relabels ${kind} ${id}: ${parts.join('; ')}${hides}`;
    },
  },
  {
    id: 'C13',
    tools: ['calendar_create_event', 'calendar_update_event', 'calendar_delete_event', 'calendar_respond_to_event'],
    summary: 'Always; lists attendees, says who is emailed',
    when(tool, args) {
      const cal = oneVal(args, ['calendarid']);
      const where = cal !== undefined ? ` on calendar ${idOf(args, ['calendarid'])}` : ' on the primary calendar';
      const notify = notifyOf(args);
      const added = attendeesOf(args, false);
      const removed = attendeesOf(args, true);
      if (tool === 'calendar_create_event') {
        const when = [oneVal(args, ['starttime']), oneVal(args, ['endtime'])].filter(present).map((x) => clean(x, 30)).join(' to ');
        const who = added.list.length || added.unreadable ? attendeeText('sends invites to', added) : 'no attendees';
        return `creates event ${quote(oneVal(args, ['summary']), 60)}${when ? ` (${when})` : ''}${where}; ${who}; ${notify}`;
      }
      const id = idOf(args, ['eventid']);
      if (tool === 'calendar_update_event') {
        const fields = Object.keys(args).filter((k) => !['eventid', 'calendarid', 'notificationlevel'].includes(norm(k))).map((k) => clean(k, 30));
        const parts = [`updates event ${id}${where}`];
        if (added.list.length || added.unreadable) parts.push(attendeeText('sends invites to', added));
        if (removed.list.length || removed.unreadable) parts.push(attendeeText('removes', removed));
        parts.push(`changes ${fields.length ? fields.join(', ') : 'nothing readable'}`);
        parts.push(notify);
        return parts.join('; ');
      }
      if (tool === 'calendar_delete_event') return `deletes event ${id}${where}; ${notify} about the cancellation`;
      const comment = oneVal(args, ['responsecomment']);
      return `answers event ${id}${where} with ${quote(oneVal(args, ['responsestatus']), 20)}${comment !== undefined ? `, comment ${quote(comment, 80)}` : ''}; the organizer sees it; ${notify}`;
    },
  },
  {
    id: 'C14',
    tools: ['chat_send_message'],
    summary: 'Always (outward: posts as you)',
    when(tool, args) {
      const conv = idOf(args, ['conversationid']);
      const thread = oneVal(args, ['threadid']);
      const texts = topVals(args, ['messagetext']);
      let body = 'no messageText';
      if (texts.length > 1) body = `CONFLICTING messageText values ${texts.map((t) => quote(t, 60)).join(' / ')}`;
      else if (texts.length === 1) body = `text ${quote(texts[0], 120)}${String(texts[0]).length > 120 ? ` (${String(texts[0]).length} chars)` : ''}`;
      const cards = flat(topVals(args, ['cards']));
      // Card text is posted too, so it is excerpted, not just counted.
      const cardText = flat(collectBy(cards, (k) => k === 'text' || k.endsWith('text') || k === 'title' || k === 'subtitle')).filter((x) => typeof x === 'string' && x.trim());
      const cardPart = cards.length ? `; plus ${cards.length} card(s)${cardText.length ? ` with text ${quote(cardText.join(' / '), 120)}` : ''}` : '';
      return `OUTWARD: posts to Chat conversation ${conv}${thread !== undefined ? ` in thread ${quote(thread, 40)}` : ''} as you: ${body}${cardPart}`;
    },
  },
  {
    id: 'C15',
    tools: ['chat_mark_as_read', 'chat_mark_as_unread', 'chat_update_notification_settings'],
    summary: 'Always (read state, notifications)',
    when(tool, args) {
      const ids = flat(topVals(args, ['conversationid', 'conversationids', 'threadid', 'threadids'])).map((x) => quote(x, 40));
      const target = ids.length ? ids.join(', ') : '(no conversation given)';
      if (tool === 'chat_mark_as_read') return `marks ${target} as read: new messages there stop showing as unread`;
      if (tool === 'chat_mark_as_unread') return `marks ${target} as unread`;
      const n = oneVal(args, ['notificationsetting']);
      const m = oneVal(args, ['mutesetting']);
      return `changes notifications for ${target}: notificationSetting=${clean(n ?? 'unchanged', 30)}, muteSetting=${clean(m ?? 'unchanged', 30)} (muting hides new messages)`;
    },
  },
  {
    id: 'C16',
    tools: ['sheets_update_values', 'sheets_update_formulas', 'sheets_update_spreadsheet', 'sheets_insert_dimension', 'slides_update_presentation'],
    summary: 'Always; names the file and range or request kinds',
    when(tool, args) {
      if (tool === 'slides_update_presentation') return `edits presentation ${idOf(args, ['presentationid'])} with ${requestKinds(args)}`;
      const file = idOf(args, ['spreadsheetid']);
      if (tool === 'sheets_update_spreadsheet') return `edits spreadsheet ${file} with ${requestKinds(args)}`;
      if (tool === 'sheets_insert_dimension') {
        const v = (n, d) => clean(oneVal(args, [n]) ?? d, 20);
        return `inserts ${v('dimension', 'rows or columns')} ${v('startindex', '?')} to ${v('endindex', '?')} into sheet ${quote(oneVal(args, ['sheetid']), 20)} of spreadsheet ${file}: every cell below or right of it moves`;
      }
      const key = tool === 'sheets_update_formulas' ? 'formulas' : 'values';
      const rows = oneVal(args, [key]);
      const n = Array.isArray(rows) ? `${rows.length} row(s)` : 'an unreadable number of rows';
      return `OVERWRITES range ${idOf(args, ['range'])} of spreadsheet ${file} with ${n} of ${key}; the old cells are replaced`;
    },
  },
  {
    id: 'C17',
    tools: ['docs_update_doc'],
    summary: 'Always; says "edits directly" unless `writeMode` is `SUGGEST`',
    when(tool, args) {
      // Suggestion mode counts ONLY as the top-level writeControl.writeMode, the one field
      // Google reads; a writeMode anywhere else is shown and means "edits directly".
      const wcs = topVals(args, ['writecontrol']).filter((w) => w && typeof w === 'object' && !Array.isArray(w));
      const topModes = wcs.flatMap((w) => Object.entries(w).filter(([k]) => norm(k) === 'writemode').map(([, v]) => String(v).toUpperCase().trim()));
      const allModes = collectBy(args, (k) => k === 'writemode').filter(present).map((m) => String(m).toUpperCase().trim());
      const suggest = wcs.length === 1 && topModes.length === 1 && topModes[0] === 'SUGGEST' && allModes.length === 1;
      const doc = idOf(args, ['documentid']);
      const kinds = requestKinds(args);
      if (suggest) return `suggests changes to Doc ${doc} (writeMode=SUGGEST, the owner accepts or rejects each) with ${kinds}`;
      const why = allModes.length ? `writeMode=${allModes.map((m) => clean(m, 30)).join('/')}${topModes.length !== allModes.length ? ', not all in writeControl' : ''}` : 'no writeMode, which defaults to EDIT';
      return `edits Doc ${doc} directly, not as suggestions (${why}; set writeControl.writeMode=SUGGEST to suggest instead) with ${kinds}`;
    },
  },
];

const EXEMPT_WRITES = [
  { tool: 'gmail_create_draft', reason: 'Nothing leaves the account. The user presses Send' },
  { tool: 'gmail_create_label', reason: 'Additive and private, and has no effect on delivery' },
  { tool: 'drive_create_file', reason: 'With no parent-like argument it lands in the user\'s own My Drive root' },
  { tool: 'forms_create_form', reason: 'Assumed to start unpublished (spike S8). Publishing is C5' },
  { tool: 'portal_toggle_servers', reason: 'The user finishes it on a portal page' },
  // mcp-nixos declares no ToolAnnotations (tools/list, measured 2026-11-19), so the verb
  // heuristic would call these writes. Both only search public nixpkgs/NixOS data.
  { tool: 'nixos_nix', reason: 'Read-only lookup of public nixpkgs and option data' },
  { tool: 'nixos_nix_versions', reason: 'Read-only lookup of public nixpkgs version history' },
];

// Sorted, so references/guarded.json (scripts/gen-guarded.js) is stable.
const GUARDED = [...new Set(RULES.flatMap((r) => r.tools))].sort();

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
