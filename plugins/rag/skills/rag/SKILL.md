---
name: rag
description: >-
  Retrieval-augmented generation over the operator's RAG corpus in Cloudflare AI Search,
  on every Claude surface. Use when the user wants to add documents/text to the searchable
  knowledge base or ask questions answered from it ("index this", "add to my notes DB",
  "what do my docs say about X", "search my knowledge base", "RAG over these files").
  Search and ingest go through the Cloudflare connector's `execute` tool; AI Search
  embeds the query itself, so no vectors are ever handled here.
---

# RAG over Cloudflare AI Search

The corpus is ONE private AI Search instance, **`rag`** (namespace `default`), in the
operator's Cloudflare account. Every call goes through the **Cloudflare connector's
`execute` tool** (`cloudflare.request(...)`), which exists on web, phone, Desktop, cloud
routines and Claude Code alike. Its tool prefix differs per surface: match the connector
name ("Cloudflare"), not a fixed prefix.

**Find the account once per session:** `GET /accounts`, then the account whose
`GET /accounts/{id}/ai-search/instances` lists `rag`. Pass that id as `account_id`.

Base path below: `B = /accounts/{account_id}/ai-search/namespaces/default/instances/rag`.

## What is in it

Each item is ONE document (chunks are made by AI Search), with five filterable
metadata fields: `corpus`, `source`, `url`, `repo`, `title`.

| `corpus` | Content |
|---|---|
| `ircc` | canada.ca immigration pages (IRCC crawl; `source` = `ircc-crawl-<topic>`) |
| `ircc-live` | answers the IRCC bot fetched live and cached |
| `repo` | a client's internal repo docs (`repo` names the repo). Never quote these outside a private answer to the operator |
| `web` | public docs (nix-darwin manual, Google Workspace Studio) |
| `misc` | anything else |

## Searching

```js
async () => cloudflare.request({ method: "POST", path: `${B}/search`, body: {
  query: "<the user's question>",
  ai_search_options: { retrieval: { max_num_results: 8, filters: { corpus: "ircc" } } },
}})
```

- `result.chunks[]` carries `text`, `score` and `item.key` / `item.metadata` (cite these).
- Omit `filters` to search everything. Equality (`{ corpus: "web" }`) and list
  (`{ source: { $in: ["ircc-crawl-pr", "ircc-crawl-work"] } }`) filters work on the five
  fields (measured 2026-11-19); a bare array value is a 400.
- Search is hybrid (meaning + keywords), so exact names and document titles hit too.
- Answer **only** from the returned chunks and cite each claim. If nothing comes back, or
  every score is low (< ~0.3), say the corpus does not cover it; never present general
  knowledge as retrieved.

## Adding a document

Upload ONE file per document (do not pre-chunk). The item KEY makes a re-ingest replace
the old copy (re-uploading a key keeps the same item, measured 2026-11-19), so build it
exactly like the corpus export did:

`<corpus>/<slug>-<first 10 hex of sha1(ident)>.md`, at most 128 characters, where `ident`
is the page URL (`ircc`, `web`), `<repo>/<path>` (`repo`) or the source name, and `slug`
is `ident` without `https://`, non `[A-Za-z0-9._/-]` runs turned into `-`, `/` into `_`,
cut to fit.

```js
async () => {
  const fd = new FormData();
  fd.append("file", new Blob(["# <title>\n\nSource: <url or path>\n\n<text>"], { type: "text/markdown" }), "<key>");
  fd.append("metadata", JSON.stringify({ corpus: "web", source: "<source>", url: "<url>", title: "<title>" }));
  return cloudflare.request({ method: "POST", path: `${B}/items`, body: fd });
}
```

- Keyword search finds a new item at once; meaning-based search only after indexing
  finishes (minutes). `GET ${B}/stats` shows `queued` / `running` / `completed` / `error`.
- Get the text first with the right tool (a fetch tool for web pages, the pdf/docx/pptx/
  xlsx skills for documents, Read for local files).
- Delete a document: `DELETE ${B}/items/{item_id}` (ask first; it is permanent).

## The local postgres server

The plugin's `postgres` MCP server still reaches the Mac's `ragdb`, frozen as the
pre-migration copy (2026-11-19). Read it only as a fallback when the Cloudflare
connector is unavailable, say so, and **never write to it**: AI Search is the one
write path, so the two cannot drift.
