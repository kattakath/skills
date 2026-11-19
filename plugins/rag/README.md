# rag

Retrieval-augmented generation over a **Cloudflare AI Search** instance: add documents,
then answer questions from that corpus, from **every Claude surface** (web, phone, Desktop,
cloud routines, Claude Code). AI Search chunks, embeds and indexes each document and
embeds the query server-side, so the model never handles vectors.

Since 2.0.0 (2026-11-19). Until then the corpus was a local pgvector database on one Mac,
reachable only where this plugin's `postgres` server could run.

## How it is reached

Through the account-wide **claude.ai Cloudflare connector** and its `execute` tool, which
calls the Cloudflare API with the user's own sign-in. The skill (`skills/rag/SKILL.md`)
carries the search and upload calls, the item-key formula that makes a re-ingest replace
its old copy, and the five filterable metadata fields (`corpus`, `source`, `url`, `repo`,
`title`).

The instance itself is declared, not clicked: `kattakath/nix-config`'s
`infra/cloudflare/ai-search.nix` (stack `cf-ai-search`) creates one private instance named
`rag` with its public endpoint off. Its content is data, uploaded by API, never kept in a
repo.

## Requires

- The claude.ai **Cloudflare** connector, signed in to the account that holds `rag`.
- Nothing else for search and ingest.

## The `postgres` server (fallback, read-only)

The plugin still starts a **`postgres` MCP server** through `scripts/launch.sh`, for the
frozen pre-migration copy of the corpus (`ragdb` on the operator's Mac). The skill reads it
only when the Cloudflare connector is unavailable and never writes to it, so there is one
write path.

**You name the launcher; the plugin ships none.** Set `launcher` (`/plugin configure rag`)
to a command that starts a stdio Postgres MCP server, or export `RAG_POSTGRES_COMMAND`.
With neither, the server does not start and says why. On the kattakath fleet the launcher
is `nix-mcp-postgres`, built by `kattakath/nix-config` (`modules/home/plugin-mcp.nix`).
