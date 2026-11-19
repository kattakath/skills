---
description: "Find where something lives across Gmail, Drive, Calendar and Chat when the app is unknown: one cross-app search, returned as a locator table. Run only when the user types /kattakath-workspace:where."
argument-hint: "<what to find, e.g. an invoice number, a name, a phrase>"
disable-model-invocation: true
---

Locate `$ARGUMENTS` across the user's Workspace with one cross-app search. Read
`${CLAUDE_PLUGIN_ROOT}/skills/kattakath-workspace/references/locator.md` first.

1. Call `workspace_search_corpus` **once**, with `query` = `$ARGUMENTS`.
   - Claude Code asks before this call (the plugin's `locator_mode` setting). A declined ask
     means stop.
   - On other surfaces nothing asks: confirm first that the user wants a search across every
     app.
2. In Claude Code the result is a locator table grouped by app, with the tool that opens
   each group. Show it with the likeliest hits first, and say which app holds the thing.
3. Do not re-run the search to read content. Open only the hit the user picks, or the single
   obvious one, with its group's tool and the row's ID.
4. If the result is NOT a locator table (raw, saved to a file, or a "locator reducer
   skipped" note), say so, and answer from the per-app search tools. Never read the saved
   file.
