# Limits, measurements and the less common tools

Each measurement carries its value, the surface it was taken on, and the date.

## What the connector cannot do

- **Refused by design** (not on the portal allowlist): send mail, post in Chat, edit a
  Doc, Sheet or deck, create or change an event (no RSVP either), share, trash, remove a
  label. A tool Google adds upstream stays hidden until nix-config's
  `infra/cloudflare/workspace-mcp-apps.nix` lists it.
- **No connector exists** for Google Keep, Meet or Messages (SMS). Keep's MCP refuses
  `keep.readonly` (invalid_scope), and Meet's returns no tools (measured 2026-11-14, portal).
  For Keep, point the user to the Gemini app, which has a built-in Keep app.
- **No Google Home**: its MCP needs a paid Home Premium Advanced subscription for every call
  (measured 2026-11-14). Point the user to the Google Home app.
- **One Google account per user.** Each app's grant is the signed-in user's own account.

## Cost and speed

- **Maps** is free while Grounding Lite is Experimental and billed per call at GA. Do not
  loop it over long lists; batch geocoding belongs in a pipeline.
- **Self-hosted apps** (`tasks_`, `forms_`, `contacts_`, `docsread_`, since 2026-11-18) run
  the open-source workspace-mcp on the operator's Cloud Run. A cold start can add a few
  seconds to the first call. A newly added app needs the user's own **Authorize** on the
  portal page; until then its tools are missing.

## Measurements

| What | Value | Surface | Date |
|---|---|---|---|
| `docs_read_doc`, one document | ~2 MB | surface not recorded (2.x skill) | 2026-11-14 |
| `workspace_search_corpus` "invoice", raw | 96,169 chars | Claude Code CLI, overflow file | 2026-11-14 |
| `workspace_search_corpus` "invoice", raw | 136,585 chars, 30 hits | surface not recorded (nix-config `workspace-mcp-apps.nix` comment, read against claude.ai's cap); the same query as the row above, so the two counts conflict | 2026-11-14 |
| `workspace_search_corpus`, a rare phrase, raw | 100,798 chars | Claude Code CLI | 2026-11-14 |
| Locator reducer, "invoice" | 96,169 → 12,632 chars (2.x table, before the 10k cap) | Claude Code CLI | 2026-11-14 |
| Tools visible with all 14 servers reporting enabled | 46 of the allowlisted set | Claude Code, account connector | 2026-11-18 |

## Tools the router does not name

| Tool | Use |
|---|---|
| `gmail_get_message`, `gmail_list_drafts`, `gmail_get_draft` | one message; the drafts folder |
| `gmail_create_label` | a new user label (exempt from confirm: additive, private) |
| `calendar_list_calendars` | which calendars exist |
| `drive_list_recent_files`, `drive_get_file_metadata` | recent files; one file's metadata |
| `docs_read_doc` | full Docs structure; large, last resort (kept until spike S6 settles it) |
| `docsread_get_doc_content`, `docsread_list_document_comments`, `docsread_search_docs` | plain text; comments; search Docs only |
| `slides_read_slide_page_thumbnail` | a slide as an image, for visual questions |
| `contacts_list_contacts`, `contacts_get_contact` | all contacts; one contact |
| `contacts_list_contact_groups`, `contacts_get_contact_group` | groups and their members |
| `contacts_manage_contact_group` | create, rename, delete a group; add or remove members (C4) |
| `contacts_manage_contacts_batch` | many contacts at once (C3) |
| `forms_get_form_response` | one response |
| `forms_set_publish_settings` | publish or close a form (C5) |
| `tasks_get_task_list`, `tasks_get_task` | one list; one task |
| `tasks_manage_task_list` | create, rename, delete a list, clear completed (C1) |
| `maps_search_along_route`, `maps_resolve_names` | places along a route; names to Place IDs |
| `portal_list_servers`, `portal_toggle_servers` | the portal's own tools: list apps; enable them via a portal page |
| `portal_toggle_single_server` | turns one app on or off with no page (C9) |
