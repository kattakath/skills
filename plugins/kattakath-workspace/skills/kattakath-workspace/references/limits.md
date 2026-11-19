# Limits, measurements and the less common tools

Each measurement carries its value, the surface it was taken on, and the date.

## What the connector cannot do

- **Refused by design:** send mail (Gmail drafts only) and share a file. Every other
  Google-hosted tool is enabled and guarded since 2026-11-19 (`editing.md`). A tool
  Google adds upstream stays hidden until nix-config's
  `infra/cloudflare/workspace-mcp-apps.nix` lists it.
- **No connector exists** for Google Keep, Meet or Messages (SMS). Keep's MCP refuses
  `keep.readonly` (invalid_scope), and Meet's returns no tools (measured 2026-11-14, portal).
  For Keep, point the user to the Gemini app, which has a built-in Keep app.
- **No Google Home**: its MCP needs a paid Home Premium Advanced subscription for every call
  (measured 2026-11-14). Point the user to the Google Home app.
- **One Google account per user.** Each app's grant is the signed-in user's own account.

## NixOS lookups

- `nixos_nix` searches or shows nixpkgs packages and NixOS / home-manager / nix-darwin
  options; `nixos_nix_versions` says which nixpkgs commit shipped a package version.
- Public data with no sign-in: the portal's `nixos` app is upstream mcp-nixos 3.1.1 on
  Cloud Run (nix-config `infra/cloudflare/workspace-mcp-apps.nix`, 2026-11-19). It is a
  crawled index, not a flake's pinned inputs: cite the pinned source for a real decision.

## Cost and speed

- **Maps** is free while Grounding Lite is Experimental and billed per call at GA. Do not
  loop it over long lists; batch geocoding belongs in a pipeline.
- **Self-hosted apps** (`tasks_`, `forms_`, `contacts_`, `docsread_`, since 2026-11-18) run
  the open-source workspace-mcp on the operator's Cloud Run. A cold start can add a few
  seconds to the first call. A newly added app needs the user's own **Authorize** on the
  portal page; until then its tools are missing.

## Reading files (measured 2026-11-19, Claude Code CLI)

- **A Google Doc: Drive's read is enough.** On 5 single-tab Docs (399 to 106,211 chars, 2
  with comments), `drive_read_file_content` and `docsread_get_doc_as_markdown` differed by
  at most 15% in size (under 6% above 1k chars). Table counts matched on all 5 and heading
  counts on 4 (0 vs 1 on the fifth). Both reached the Doc's end: the last 40 characters
  were identical on 2 Docs and found in the Docs body on the other 3. With
  `includeComments: true`, Drive gave the same comment threads as
  `docsread_list_document_comments` and `docs_read_doc` (6 threads with 12 replies; 3
  threads). Without the flag nothing was cut off; the text differed in whitespace and line
  breaks only (on one Doc, 1,105 non-breaking spaces became plain). Emoji: none in the
  sample, so untested.
- **`docs_read_doc` adds nothing for reading.** Its extra bulk is layout, styles and
  positions, which only an edit needs (`editing.md`).
- **A Google Sheet: never read it through Drive.** Drive renders a sample of every tab; use
  `sheets_get_values` per tab.
- **Drive search:** the query field is `title`; `name contains` fails with "Unsupported query
  field: name". Fewer hits than the page size do not mean the end while a next-page token
  is present. In relevance order a page can open with the final hit of the one before, so
  keep a set of seen ids.
- **Slides:** pass `fields`. A mask of ids, sizes, transforms and text cut the read by 78%
  and 82% on two decks.
- **docsread can be missing.** Its tools were absent from one claude.ai-connector session's
  list while a fresh `claude -p` listed them. Drive's read needs no extra Authorize.

## Another Google skill

Anthropic's own `google-workspace` skill also fires on requests to edit or make Docs,
Sheets and Slides files, and it steers to Anthropic's Google connectors. Measured 2026-11-19 in
`claude -p` with the skill listing budget raised, so both descriptions show:

| Router description | Edit/create probes won by `google-workspace` | Read/add-row probes |
|---|---|---|
| 3.0.0 | 4 of 4 | 0 of 4 |
| 3.0.1, opening with "Use this, not google-workspace" | 0 of 4 (0 of 6 on a draft with the same opening) | 0 of 4 |

With the default budget the CLI listed that skill with no description (291 skills
listed), and it never fired (0 of 14). The CLI drops descriptions of the least-used skills
first, so that can change. Since 3.1.0 the two divide the work: this router picks the
account and connector and guards the write; Anthropic's skill may supply edit mechanics
(positions, ranges, revision guards), used with this connector's tools
(`editing.md`). To remove the overlap outright, turn the skill off: on claude.ai,
or in Claude Code with `skillOverrides` set to `"off"`. That also removes its guidance for
Anthropic's own Google connectors, so it is the user's call.

## Measurements

| What | Value | Surface | Date |
|---|---|---|---|
| `docs_read_doc` vs `drive_read_file_content`, 5 Docs | 11,251-2,032,523 vs 399-106,211 chars (10-28x) | Claude Code CLI, `claude -p` | 2026-11-19 |
| `slides_read_presentation`, unmasked vs `fields` mask | 194,628 vs 43,722 chars (12 slides); 761,171 vs 140,398 (21 slides) | Claude Code CLI, `claude -p` | 2026-11-19 |
| Drive read of a 10-tab Sheet vs `sheets_get_values` on tab 1 | 595 lines for the whole file vs 4,822 rows | Claude Code CLI, `claude -p` | 2026-11-19 |
| `drive_search_files`, relevance order, page size 5, 9 pages | 9 of 45 ids repeated: each follow-up page began with the last id of the page before | Claude Code CLI, `claude -p` | 2026-11-19 |
| `drive_search_files`, `modifiedTime desc`, page size 5, 9 pages | 0 of 45 repeated | Claude Code CLI, `claude -p` | 2026-11-19 |
| `drive_search_files`, `fullText` query, snippets on, page size 20 | 5 files and a next-page token (a short page) | Claude Code CLI, `claude -p` | 2026-11-19 |
| `workspace_search_corpus` "invoice", raw | 96,169 chars | Claude Code CLI, overflow file | 2026-11-14 |
| `workspace_search_corpus` "invoice", raw | 136,585 chars, 30 hits | surface not recorded (nix-config `workspace-mcp-apps.nix` comment, read against claude.ai's cap); the same query as the row above, so the two counts conflict | 2026-11-14 |
| `workspace_search_corpus`, a rare phrase, raw | 100,798 chars | Claude Code CLI | 2026-11-14 |
| Locator reducer, "invoice" | 96,169 → 12,632 chars (2.x table, before the 10k cap) | Claude Code CLI | 2026-11-14 |
| Tools visible with all 14 servers reporting enabled | 46 of the allowlisted set | surface not recorded (3.0.0 design review) | 2026-11-18 |

## Tools the router does not name

| Tool | Use |
|---|---|
| `gmail_get_message`, `gmail_list_drafts`, `gmail_get_draft` | one message; the drafts folder |
| `gmail_create_label` | a new user label (exempt from confirm: additive, private) |
| `gmail_list_labels` → `gmail_label_thread` | organize mail (C8) |
| `gmail_search_threads` (`in:trash` / `in:spam`) → the C7 tool | restore trash or spam |
| `docsread_inspect_doc_structure` | a Doc's structure |
| `drive_get_file_permissions` | who has access to a file |
| `people_get_user_profile` | who am I |
| `chat_search_messages` | search chats |
| `forms_get_form` → `forms_list_form_responses` | form responses |
| `forms_create_form` → `forms_batch_update_form` | make a form; publish only on request (C5) |
| `calendar_list_calendars` | which calendars exist |
| `drive_list_recent_files`, `drive_get_file_metadata` | recent files; one file's metadata |
| `docs_read_doc` | full Docs JSON for positions; not needed to read (see Reading files) |
| `docsread_get_doc_content`, `docsread_list_document_comments`, `docsread_search_docs` | plain text; comments (Drive's `includeComments` gives the same); search Docs only |
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
