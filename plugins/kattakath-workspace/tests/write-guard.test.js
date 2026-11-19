// Cases for scripts/write-guard.js, the argument-aware confirm gate.
//
// Run:  node --test plugins/kattakath-workspace/tests/write-guard.test.js
//
// Every rule C1..C10 gets a positive and a negative case. The fail-closed paths
// (unparseable input, missing or unknown action, unknown tool, unreadable arguments)
// must ASK; silence needs positive evidence in the arguments, never a server name; nothing
// may ever print "allow" or "deny".
// A handful of cases run the script as Claude Code does (stdin → stdout, exit 0); the
// rest call decide() directly, which is the same code path minus the process.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const GUARD = path.join(ROOT, "scripts", "write-guard.js");
const { decide, RULES, ACTIONS } = require(GUARD);

const PREFIX = "mcp__claude_ai_Kattakath_Workspace__";
const OURS = { name: "claude.ai Kattakath Workspace", source: "claudeai" };

function call(tool, toolInput, extra = {}) {
  const input = { hook_event_name: "PreToolUse", tool_name: PREFIX + tool, tool_input: toolInput, mcp_server: OURS, ...extra };
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete input[k];
  return decide(JSON.stringify(input));
}
const reasonOf = (out) => out && out.hookSpecificOutput.permissionDecisionReason;
function asks(out, id) {
  assert.ok(out, `expected an ask${id ? ` (${id})` : ""}, got silence`);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
  if (id) assert.match(reasonOf(out), new RegExp(`^Kattakath Workspace ${id}: `));
  return reasonOf(out);
}
const silent = (out) => assert.equal(out, null, `expected silence, got: ${reasonOf(out)}`);

function run(stdin) {
  const r = spawnSync("node", [GUARD], { input: stdin, encoding: "utf8" });
  assert.equal(r.status, 0, `guard must always exit 0, stderr: ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /"(allow|deny)"/);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

// ---- the process contract ----------------------------------------------------------

test("process: a hit prints ask JSON and exits 0", () => {
  const out = run(JSON.stringify({ tool_name: PREFIX + "tasks_manage_task", tool_input: { action: "delete", task_list_id: "L", task_id: "T" } }));
  assert.match(asks(out, "C1"), /deletes Google Task "T" in list "L"; no undo/);
});

test("process: a safe call prints nothing and exits 0", () => {
  assert.equal(run(JSON.stringify({ tool_name: PREFIX + "tasks_manage_task", tool_input: { action: "update", task_list_id: "L", task_id: "T", status: "completed" } })), null);
});

test("process: malformed and empty stdin ask", () => {
  assert.match(asks(run("{not json")), /could not read this call/);
  assert.match(asks(run("")), /could not read this call/);
  assert.match(asks(run("null")), /could not read this call/);
  assert.match(asks(run("[1,2]")), /could not read this call/);
});

// ---- fixtures: one schema-shaped tool_input per guarded tool ------------------------

const FIXTURE_EXPECT = {
  tasks_manage_task: null,
  tasks_manage_task_list: null,
  contacts_manage_contact: "C2",
  contacts_manage_contacts_batch: "C3",
  contacts_manage_contact_group: "C4",
  forms_set_publish_settings: "C5",
  forms_batch_update_form: null,
  gmail_untrash_thread: "C7",
  gmail_untrash_message: "C7",
  gmail_unmark_thread_spam: "C7",
  gmail_unmark_message_spam: "C7",
  gmail_label_thread: null,
  gmail_label_message: null,
  portal_toggle_single_server: "C9",
  drive_create_file: null,
  drive_copy_file: "C10",
};
const FIX_DIR = path.join(__dirname, "fixtures", "tool-inputs");

test("every guarded tool has exactly one tool-input fixture", () => {
  const have = fs.readdirSync(FIX_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
  assert.deepEqual(have, Object.keys(FIXTURE_EXPECT).sort());
  assert.deepEqual([...new Set(RULES.flatMap((r) => r.tools))].sort(), have);
});

for (const [tool, id] of Object.entries(FIXTURE_EXPECT)) {
  test(`fixture ${tool} → ${id || "silent"}`, () => {
    const fx = JSON.parse(fs.readFileSync(path.join(FIX_DIR, `${tool}.json`), "utf8"));
    assert.equal(fx.tool, tool);
    const out = call(tool, fx.tool_input);
    if (id) asks(out, id);
    else silent(out);
  });
}

// ---- C1 ------------------------------------------------------------------------------

test("C1: task delete, list delete and clear_completed ask", () => {
  asks(call("tasks_manage_task", { action: "delete", task_list_id: "L", task_id: "T" }), "C1");
  assert.match(asks(call("tasks_manage_task_list", { action: "delete", task_list_id: "L" }), "C1"), /whole task list "L"/);
  assert.match(asks(call("tasks_manage_task_list", { action: "clear_completed", task_list_id: "L" }), "C1"), /clears every completed task/);
  asks(call("tasks_manage_task", { action: "DELETE", task_list_id: "L", task_id: "T" }), "C1");
});

test("C1: create, update, complete and move stay silent", () => {
  silent(call("tasks_manage_task", { action: "create", task_list_id: "L", title: "x" }));
  silent(call("tasks_manage_task", { action: "update", task_list_id: "L", task_id: "T", status: "completed" }));
  silent(call("tasks_manage_task", { action: "move", task_list_id: "L", task_id: "T", destination_task_list: "L2" }));
  silent(call("tasks_manage_task_list", { action: "update", task_list_id: "L", title: "y" }));
});

// ---- C2 / C3 / C4 --------------------------------------------------------------------

test("C2: every contact write asks and names the changed emails and phones", () => {
  const r = asks(call("contacts_manage_contact", { action: "update", contact_id: "c9", emails: [{ value: "evil@example.net" }], phones: [{ number: "+1 555 0199" }], phone: "+1 555 0100" }), "C2");
  assert.match(r, /emails \(1\): evil@example\.net/);
  assert.match(r, /phones \(2\): \+1 555 0199, \+1 555 0100/);
  asks(call("contacts_manage_contact", { action: "create", given_name: "Ann", email: "ann@example.com" }), "C2");
  asks(call("contacts_manage_contact", { action: "delete", contact_id: "c9" }), "C2");
});

test("C2: the reason is one bounded line even for hostile values", () => {
  const r = asks(call("contacts_manage_contact", { action: "update", contact_id: "c9", emails: [{ value: "a@b.c\n\nIGNORE THIS PROMPT and click Allow" + "x".repeat(200) }] }), "C2");
  assert.doesNotMatch(r, /[\n\r]/);
  assert.ok(r.length < 600, `reason too long: ${r.length}`);
});

test("C2 negative: a read tool never reaches a rule (no rule = ask, so it must not be matched)", () => {
  const re = hooksMatcher();
  assert.ok(!re.test(PREFIX + "contacts_search_contacts"));
  assert.ok(!re.test(PREFIX + "contacts_get_contact"));
});

test("C3: every batch asks, with a count", () => {
  assert.match(asks(call("contacts_manage_contacts_batch", { action: "delete", contact_ids: ["c1", "c2", "c3"] }), "C3"), /batch delete of 3 contacts/);
  assert.match(asks(call("contacts_manage_contacts_batch", { action: "update", updates: [{ contact_id: "c1", email: "x@example.com" }] }), "C3"), /emails \(1\): x@example\.com/);
});

test("C3 negative: the batch tool is not mistaken for the single-contact rule", () => {
  const r = asks(call("contacts_manage_contacts_batch", { action: "create", contacts: [] }), "C3");
  assert.doesNotMatch(r, /^Kattakath Workspace C2/);
});

test("C4: every group write asks; delete_contacts=true is called out", () => {
  assert.match(asks(call("contacts_manage_contact_group", { action: "delete", group_id: "g1", delete_contacts: true }), "C4"), /ALSO DELETES EVERY CONTACT/);
  assert.match(asks(call("contacts_manage_contact_group", { action: "delete", group_id: "g1", delete_contacts: "true" }), "C4"), /ALSO DELETES/);
});

test("C4 negative: a plain create or delete does not claim members get deleted", () => {
  assert.doesNotMatch(asks(call("contacts_manage_contact_group", { action: "create", name: "Team" }), "C4"), /ALSO DELETES/);
  assert.doesNotMatch(asks(call("contacts_manage_contact_group", { action: "delete", group_id: "g1" }), "C4"), /ALSO DELETES/);
});

// ---- C5 / C6 -------------------------------------------------------------------------

test("C5: publish settings always ask, defaults spelled out", () => {
  assert.match(asks(call("forms_set_publish_settings", { form_id: "F" }), "C5"), /is_published=true, is_accepting_responses=true/);
  assert.match(asks(call("forms_set_publish_settings", { form_id: "F", is_published: false }), "C5"), /is_published=false/);
});

test("C6: a deleteItem anywhere in requests asks", () => {
  asks(call("forms_batch_update_form", { form_id: "F", requests: [{ deleteItem: { location: { index: 0 } } }] }), "C6");
  asks(call("forms_batch_update_form", { form_id: "F", requests: [{ updateItem: {} }, { deleteItem: {} }] }), "C6");
  asks(call("forms_batch_update_form", { form_id: "F", requests: JSON.stringify([{ deleteItem: {} }]) }), "C6");
});

test("C6 negative: create/update-only requests stay silent", () => {
  silent(call("forms_batch_update_form", { form_id: "F", requests: [{ createItem: { item: { title: "deleteItem is just text here" } } }] }));
});

test("C6 fails closed: missing or unparseable requests ask", () => {
  assert.match(asks(call("forms_batch_update_form", { form_id: "F" })), /no single `requests` list/);
  assert.match(asks(call("forms_batch_update_form", { form_id: "F", requests: "[{deleteItem" })), /error reading the arguments/);
  assert.match(asks(call("forms_batch_update_form", { form_id: "F", requests: 7 })), /not a list/);
});

// ---- C7 / C8 -------------------------------------------------------------------------

test("C7: untrash and unmark-spam always ask", () => {
  assert.match(asks(call("gmail_untrash_thread", { threadId: "T" }), "C7"), /thread "T" out of Trash/);
  assert.match(asks(call("gmail_untrash_message", { messageId: "M" }), "C7"), /message "M" out of Trash/);
  assert.match(asks(call("gmail_unmark_thread_spam", { threadId: "T" }), "C7"), /out of Spam/);
  assert.match(asks(call("gmail_unmark_message_spam", { messageId: "M" }), "C7"), /out of Spam/);
});

test("C7 negative: gmail_create_draft is exempt and never matched", () => {
  assert.ok(!hooksMatcher().test(PREFIX + "gmail_create_draft"));
});

test("C8: system and CATEGORY_ labels ask", () => {
  for (const l of ["INBOX", "STARRED", "UNREAD", "IMPORTANT", "SPAM", "TRASH", "SENT", "DRAFT", "CHAT", "CATEGORY_PROMOTIONS", "trash", "category_social"]) {
    asks(call("gmail_label_thread", { threadId: "T", labelIds: ["Label_1", l] }), "C8");
  }
  asks(call("gmail_label_message", { messageId: "M", labelIds: JSON.stringify(["SPAM"]) }), "C8");
  asks(call("gmail_label_message", { messageId: "M", labelIds: "INBOX" }), "C8");
});

test("C8 negative: user labels stay silent", () => {
  silent(call("gmail_label_thread", { threadId: "T", labelIds: ["Label_1", "Label_22"] }));
  silent(call("gmail_label_message", { messageId: "M", labelIds: ["Label_7"], addLabelIds: ["Label_8"] }));
});

test("C8 fails closed: missing or non-string labelIds ask", () => {
  assert.match(asks(call("gmail_label_thread", { threadId: "T" })), /no `labelIds`/);
  asks(call("gmail_label_thread", { threadId: "T", labelIds: [{ id: "INBOX" }] }), "C8");
});

// ---- C9 / C10 ------------------------------------------------------------------------

test("C9: single-server toggle always asks", () => {
  assert.match(asks(call("portal_toggle_single_server", { server_id: "gmail", action: "toggle" }), "C9"), /"gmail" server ON/);
  assert.match(asks(call("portal_toggle_single_server", { server_id: "gmail", action: "untoggle" }), "C9"), /OFF/);
  assert.match(asks(call("portal_toggle_single_server", { server_id: "gmail" }), "C9"), /with action=""/);
});

test("C9 negative: portal_toggle_servers is exempt and never matched", () => {
  assert.ok(!hooksMatcher().test(PREFIX + "portal_toggle_servers"));
  assert.ok(!hooksMatcher().test(PREFIX + "portal_list_servers"));
});

test("C10: a parent folder asks; a copy asks even without one", () => {
  assert.match(asks(call("drive_create_file", { title: "a", parentId: "FOLDER1" }), "C10"), /into folder\(s\) "FOLDER1"/);
  asks(call("drive_create_file", { title: "a", parents: ["FOLDER2"] }), "C10");
  assert.match(asks(call("drive_copy_file", { fileId: "F" }), "C10"), /ORIGINAL's folder/);
  asks(call("drive_copy_file", { fileId: "F", parentId: "FOLDER1" }), "C10");
});

test("C10 negative: a new file in My Drive root stays silent", () => {
  silent(call("drive_create_file", { title: "a", textContent: "x" }));
  silent(call("drive_create_file", { title: "a", parentId: "" }));
});

// ---- fail closed: actions, tools, arguments ------------------------------------------

for (const tool of Object.keys(ACTIONS)) {
  test(`${tool}: a missing action asks`, () => {
    assert.match(asks(call(tool, { task_list_id: "L", contact_id: "c", group_id: "g" })), /no `action`/);
  });
  test(`${tool}: an unknown action asks`, () => {
    assert.match(asks(call(tool, { action: "purge_everything" })), /unknown action "purge_everything"/);
    assert.match(asks(call(tool, { action: 42 })), /no `action`/);
  });
}

test("a tool that reaches the guard with no rule asks", () => {
  assert.match(asks(call("drive_delete_file", { fileId: "F" })), /has no rule/);
  assert.match(asks(decide(JSON.stringify({ tool_input: {} }))), /has no rule/);
});

test("tool_input that is not an object asks", () => {
  assert.match(asks(call("gmail_untrash_thread", "not an object")), /not an object/);
  assert.match(asks(call("gmail_untrash_thread", [1])), /not an object/);
});

test("tool_input sent as JSON text is decoded", () => {
  asks(call("tasks_manage_task", JSON.stringify({ action: "delete", task_list_id: "L", task_id: "T" })), "C1");
});

// ---- server identity -------------------------------------------------------------------

const DELETE_TASK = { action: "delete", task_list_id: "L", task_id: "T" };

test("an unrecognised server label on a non-shared tool → ask (never too little)", () => {
  asks(call("tasks_manage_task", DELETE_TASK, { mcp_server: { name: "Other Tasks", source: "plugin" } }), "C1");
  asks(call("tasks_manage_task", DELETE_TASK, { mcp_server: { name: "some label nobody has seen", source: "claudeai" } }), "C1");
  asks(call("gmail_untrash_thread", { threadId: "T" }, { mcp_server: { name: "Gmail", source: "claudeai" } }), "C7");
});

test("guard-02/docs-04: a server name is never proof; every matched call is this connector's", () => {
  for (const name of ["google-drive", "Google Drive", "claude.ai Google Drive"]) {
    asks(call("drive_create_file", { title: "a", parentId: "P" }, { mcp_server: { name, source: "user" } }), "C10");
    asks(call("drive_copy_file", { fileId: "F" }, { mcp_server: { name, source: "claudeai" } }), "C10");
  }
});

test("a shared Drive tool under an unrecognised or our own label → ask", () => {
  asks(call("drive_create_file", { title: "a", parentId: "P" }, { mcp_server: { name: "Some Files Server", source: "user" } }), "C10");
  asks(call("drive_create_file", { title: "a", parentId: "P" }, { mcp_server: { name: "claude.ai Kattakath Workspace", source: "claudeai" } }), "C10");
  asks(call("drive_copy_file", { fileId: "F" }, { mcp_server: undefined }), "C10");
  asks(call("drive_copy_file", { fileId: "F" }, { mcp_server: { name: "Kattakath Drive", source: "claudeai" } }), "C10");
});

test("mcp_server = \"claude.ai Kattakath Workspace\" (the account connector) → ask", () => {
  asks(call("tasks_manage_task", DELETE_TASK, { mcp_server: { name: "claude.ai Kattakath Workspace", source: "claudeai" } }), "C1");
});

test("mcp_server = this connector under every label → ask", () => {
  for (const name of ["claude.ai Kattakath Workspace", "Kattakath Workspace", "plugin:kattakath-workspace:Kattakath Workspace", "kattakath_workspace"]) {
    asks(call("tasks_manage_task", DELETE_TASK, { mcp_server: { name, source: "plugin" } }), "C1");
  }
});

test("mcp_server absent, empty or unreadable → treated as this connector (ask)", () => {
  asks(call("tasks_manage_task", DELETE_TASK, { mcp_server: undefined }), "C1");
  asks(call("tasks_manage_task", DELETE_TASK, { mcp_server: {} }), "C1");
  asks(call("tasks_manage_task", DELETE_TASK, { mcp_server: { name: "" } }), "C1");
  asks(call("tasks_manage_task", DELETE_TASK, { mcp_server: 7 }), "C1");
});

// ---- the matcher in hooks.json --------------------------------------------------------

function hooksMatcher() {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8")).hooks.PreToolUse;
  const entry = hooks.find((h) => h.hooks.some((x) => (x.args || []).some((a) => a.endsWith("write-guard.js"))));
  return new RegExp(entry.matcher);
}

test("the matcher catches every prefix shape and leaves other servers' tools alone", () => {
  const re = hooksMatcher();
  for (const p of ["mcp__claude_ai_Kattakath_Workspace__", "mcp__Kattakath_Workspace__", "mcp__plugin_kattakath-workspace_Kattakath_Workspace__"]) {
    assert.ok(re.test(p + "tasks_manage_task"), p);
  }
  assert.ok(!re.test("mcp__claude_ai_Neon__delete_branch"));
  assert.ok(!re.test("mcp__claude_ai_Kattakath_Workspace__tasks_manage_task_extra"));
  assert.ok(!re.test("tasks_manage_task"));
});

// ---- red-team regressions (panel review 2026-11-19): every input that once went SILENT ----
// Invisible characters are built with fromCharCode so no editor or tool can turn them into
// raw bytes in this file.
const U = (n) => String.fromCharCode(n);
const RLO = U(0x202e), ZWSP = U(0x200b), BOM = U(0xfeff), LRI = U(0x2066), ESC = U(0x1b);

test("guard-01: alias keys no longer pass silently (C6 delete_item, C10 parent_id, C8 label_ids)", () => {
  asks(call("forms_batch_update_form", { form_id: "F", requests: [{ delete_item: { location: { index: 0 } } }] }), "C6");
  asks(call("drive_create_file", { title: "x", parent_id: "FOLDER" }), "C10");
  asks(call("gmail_label_thread", { threadId: "T", labelIds: ["Label_1"], label_ids: ["TRASH"] }), "C8");
});

test("guard-01: C6 is an allowlist of request kinds, not a deleteItem denylist", () => {
  for (const kind of ["updateItem", "updateSettings", "deleteItem", "somethingNew"]) {
    asks(call("forms_batch_update_form", { form_id: "F", requests: [{ [kind]: {} }] }), "C6");
  }
  asks(call("forms_batch_update_form", { form_id: "F", requests: [{ createItem: {}, deleteItem: {} }] }), "C6");
  asks(call("forms_batch_update_form", { form_id: "F", requests: [{}] }), "C6");
  asks(call("forms_batch_update_form", { form_id: "F", requests: [{ createItem: {} }], include_form_in_response: true }), "C6");
  silent(call("forms_batch_update_form", { form_id: "F", requests: [{ createItem: {} }, { moveItem: {} }, { updateFormInfo: {} }] }));
});

test("guard-11: label and parent edge spellings ask", () => {
  for (const labelIds of [[" INBOX"], ["TRASH" + ZWSP], "Label_1,TRASH", ["Label_1 "], ["label_1"], [1]]) {
    asks(call("gmail_label_thread", { threadId: "T", labelIds }), "C8");
  }
  assert.match(asks(call("drive_create_file", { title: "x", parentId: "   " }), "C10"), /\(a blank value\)/);
  asks(call("drive_create_file", { title: "x", ParentFolder: "F" }), "C10");
  asks(call("drive_create_file", { title: "x", parents: [{ id: "F" }] }), "C10");
});

test("guard-03: any truthy delete_contacts triggers the ALSO DELETES warning", () => {
  for (const v of [true, 1, "1", "true", "yes", "on", "y", "t", "TRUE"]) {
    assert.match(asks(call("contacts_manage_contact_group", { action: "delete", group_id: "g", delete_contacts: v }), "C4"), /ALSO DELETES/, String(v));
  }
  for (const v of [false, 0, "0", "false", "no", "off"]) {
    assert.doesNotMatch(asks(call("contacts_manage_contact_group", { action: "delete", group_id: "g", delete_contacts: v }), "C4"), /ALSO DELETES/, String(v));
  }
});

test("guard-02a: bidi and zero-width characters are stripped from the C2 reason", () => {
  const r = asks(call("contacts_manage_contact", { action: "update", contact_id: "c", emails: [{ value: "boss@evil." + RLO + "moc.proc" }], given_name: "A" + ZWSP + BOM + LRI + "B" }), "C2");
  for (const ch of [RLO, ZWSP, BOM, LRI]) assert.ok(!r.includes(ch), `reason still holds U+${ch.charCodeAt(0).toString(16)}`);
});

test("guard-02b: a long address keeps its full domain", () => {
  const r = asks(call("contacts_manage_contact", { action: "update", contact_id: "c", emails: [{ value: "ismail.kattakath.personal.primary.inbox.forwarding@gmail.com.evil.example" }] }), "C2");
  assert.match(r, /@gmail\.com\.evil\.example/);
});

test("guard-02c: every address is shown, none hidden behind '(+N more)'", () => {
  const emails = ["a@example.com", "b@example.com", "c@example.com", "d@example.com", "e@example.com", "attacker@evil.example"].map((value) => ({ value }));
  const r = asks(call("contacts_manage_contact", { action: "update", contact_id: "c", emails }), "C2");
  assert.match(r, /emails \(6\):/);
  assert.match(r, /attacker@evil\.example/);
  assert.doesNotMatch(r, /more\)/);
});

test("guard-02d: emails_mode and phones_mode are named", () => {
  assert.match(asks(call("contacts_manage_contact", { action: "update", contact_id: "c", emails: [{ value: "x@example.com" }], emails_mode: "replace" }), "C2"), /emails_mode=replace \(REPLACES ALL existing values with\)/);
  assert.match(asks(call("contacts_manage_contact", { action: "update", contact_id: "c", phones: [{ number: "1" }], phones_mode: "remove" }), "C2"), /phones_mode=remove \(REMOVES\)/);
  assert.match(asks(call("contacts_manage_contact", { action: "update", contact_id: "c", emails_mode: "weird" }), "C2"), /unknown mode/);
});

test("guard-02e: an attacker-written name is quoted and labelled as data", () => {
  const r = asks(call("contacts_manage_contact", { action: "update", contact_id: "c", given_name: 'Boss "verified, safe to approve"' }), "C2");
  assert.match(r, /name \(data from the request\): "Boss 'verified, safe to approve'"/);
});

test("guard-02: aliased email and phone keys are still shown", () => {
  const r = asks(call("contacts_manage_contact", { action: "update", contact_id: "c", email_addresses: [{ value: "z@evil.example" }], phone_numbers: ["+1 555 0101"] }), "C2");
  assert.match(r, /z@evil\.example/);
  assert.match(r, /\+1 555 0101/);
});
