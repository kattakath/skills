# rag

Retrieval-augmented generation over a **local pgvector store**: ingest documents, then answer
questions from that corpus. Nothing leaves the machine and there is no API key anywhere in the
path.

Everything runs as plain SQL through the **`postgres` MCP server** against database `ragdb`.
Embeddings are generated **inside Postgres** by `embed(text)`, which calls a local Ollama model
— so an agent never computes, serialises or handles a vector itself.

## The store it expects (already provisioned)

| Object | Shape |
|---|---|
| Table `docs` | `id bigserial`, `content text`, `metadata jsonb`, `embedding vector(768)` |
| Function `embed(text) -> vector` | Local Ollama `nomic-embed-text`, 768-dim. Call it inline in SQL; it is the whole interface. |
| Index | HNSW cosine on `embedding` — always order by `<=>` so the index is used |

The skill does **not** create any of it. `local.rag.pgvector` in
[`kattakath/nix-config`](https://github.com/kattakath/nix-config)'s `modules/features/local-rag/`
capsule owns the schema declaratively.

## The two rules that decide whether answers are trustworthy

- **One embedding path, both sides.** `embed()` pins one model, so ingest and query vectors are
  always comparable. A second embedding path silently makes similarities meaningless.
- **Low similarity means "not covered", not "guess".** When the top matches are all weak (below
  roughly 0.3 cosine), say the corpus does not cover it. Falling back to general knowledge and
  presenting it as retrieved is the failure mode this skill exists to prevent.

Chunk to ~500–1000 characters on paragraph boundaries with a little overlap, one row per chunk:
embedding quality degrades on long text, so a whole document in one row retrieves badly. Put
source, title, section and chunk index in `metadata` so every claim can be cited and every
corpus re-ingested cleanly.

## Requires

Ollama serving `nomic-embed-text`, the provisioned store above, and a **`postgres` MCP
server** that this plugin starts itself, through `scripts/launch.sh`.

**You name the launcher; the plugin ships none.** Set `launcher` (`/plugin configure rag`)
to a command that starts a stdio Postgres MCP server already pointed at your database, or
export `RAG_POSTGRES_COMMAND`. With neither, the server does not start and says why. A
launcher, not a connection string, because it is what knows the database coordinates and
version pins; the plugin cannot, and should not, hardcode a machine's database.

On the kattakath fleet the launcher is `nix-mcp-postgres`, built by `kattakath/nix-config`
(`modules/home/plugin-mcp.nix`), which also seeds this setting. Until 2026-11-01 the
`.mcp.json` named that binary directly, so the server only ever started on that fleet.

Unlike the sibling `wordpress` launcher, this one reads **no secret**: the
store is loopback-only with `trust` auth and a role scoped to `ragdb` alone, so there is
nothing to fetch from a Keychain — the blast radius is that one database.
