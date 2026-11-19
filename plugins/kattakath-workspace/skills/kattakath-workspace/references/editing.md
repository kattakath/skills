# Editing: mail cleanup, events, Chat, Docs, Sheets and Slides

Every tool here was enabled on 2026-11-19 (policy: all tools, guarded). Each one asks
first: the Claude Code write guard (C11-C17) names the change, and an ask rule keeps the
prompt under bypass. On claude.ai web and phone neither runs, so the confirm table in
SKILL.md is the only guard: say what will change and get a yes.

## Who owns what

- **This skill** owns the account, the connector (Kattakath Workspace) and the guards.
  Never switch to another Google connector to make an edit.
- **Anthropic's `google-workspace` skill** may supply the edit MECHANICS: document
  positions, cell ranges, slide layout, revision guards and its helper scripts. Use them
  with this connector's tools (the same Google request shapes), not its connectors.

## Route

| Intent | Call |
|---|---|
| Trash or spam a thread | `gmail_search_threads` → `gmail_trash_thread` / `gmail_mark_thread_spam` (C11); one message: `gmail_trash_message` / `gmail_mark_message_spam` |
| Remove a label | `gmail_unlabel_thread` / `gmail_unlabel_message` (C12). Removing `INBOX` archives; `UNREAD` marks read |
| Add and remove labels at once | `gmail_update_message_labels` (C12) |
| Trash or spam via `labelOption` | `gmail_apply_sensitive_thread_label` / `gmail_apply_sensitive_message_label` (C11); Google prefers the trash/spam tools |
| New event / invite | `calendar_suggest_time` → `calendar_create_event` (C13). Attendees get mail unless `notificationLevel` is `NONE` |
| Move or edit an event | `calendar_get_event` → `calendar_update_event` (C13) |
| Cancel an event | `calendar_delete_event` (C13); say whether attendees are emailed |
| RSVP | `calendar_respond_to_event` (C13) |
| Post in Chat | `chat_search_conversations` → `chat_send_message` (C14). Outward: show the exact text first |
| Who is in a space | `chat_list_memberships` |
| Read state, mute | `chat_mark_as_read` / `chat_mark_as_unread`; `chat_get_notification_settings` → `chat_update_notification_settings` (C15) |
| Write cells | `sheets_get_values` → `sheets_update_values`, or `sheets_update_formulas` (C16) |
| Rows/columns, tabs, formats | `sheets_insert_dimension`; `sheets_update_spreadsheet` (batchUpdate requests) (C16) |
| Edit a deck | `slides_read_presentation` → `slides_update_presentation` (C16) |
| Edit a Doc | `docs_read_doc` for positions → `docs_update_doc` (C17) |

## Docs: suggest by default

Send `docs_update_doc` with `writeControl: {writeMode: "SUGGEST"}` so the owner accepts or
rejects each change. Edit directly only when the user asks for it; the prompt then says
"edits directly, not as suggestions". Pass `writeControl.requiredRevisionId` (the revision
from the read, or from the last `docs_update_doc` reply) so a Doc changed in between
rejects the write.

## Still refused

Sending mail (draft it; the user presses Send) and sharing a file. No tool exists for
either, and no workaround.
