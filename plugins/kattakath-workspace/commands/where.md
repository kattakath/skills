---
description: Find where something lives across Gmail, Drive, Calendar and Chat when the app is unknown — one cross-app search, returned as a locator table
argument-hint: "<what to find, e.g. an invoice number, a name, a phrase>"
---

Locate `$ARGUMENTS` with the **kattakath-workspace** skill
(`${CLAUDE_PLUGIN_ROOT}/skills/kattakath-workspace/SKILL.md`, § 1 "Where is it?").

1. Call `workspace_search_corpus` **once** with `query` = `$ARGUMENTS`. The plugin's gate asks
   the user to allow it; that click is the on-demand switch. If the user declines, stop.
2. The plugin's hook returns a locator table, not content: app, title, date, sender or file
   type, link, and the tool that opens each hit. Show it grouped by app, the likeliest hits
   first, and say which app holds the thing.
3. Do not re-run the search to read content. To open a hit, call the tool in its "Open with"
   column (`gmail_get_thread`, `drive_read_file_content`, `calendar_get_event`,
   `chat_list_messages`) — only for the hit the user picks, or the single obvious one.
4. If the result is NOT a locator table (it says it was saved to a file), the hook did not
   run: say so, and answer from the per-app search tools instead of reading the file.
