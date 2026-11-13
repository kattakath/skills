# scrape-harness

Claude Code gates, agents, runbooks and a monitor for a polite, typed scraping pipeline. **Every rule is
read from the project's `pipeline.toml`** (schema `pipeline.v1`): the CLI's name, its environment
variables, the crawled site's hosts, the secrets only the CLI may read, the stages and their network
class. The plugin hard-codes none of them.

```
/plugin install scrape-harness --marketplace kattakath/skills
```

A project normally enables it from its generated `.claude/settings.json` instead (see below).

## What it ships

| Part | What it does |
|---|---|
| `PreToolUse(Bash)` hook | Blocks a networked pipeline command unless it is planned (`--plan`), offline (`--dry-run`, a fixture driver) or carries the operator's approval flag (then it asks); blocks direct HTTP to the crawled site and any command expanding a declared secret. |
| `PreToolUse(Write\|Edit\|NotebookEdit)` hook | No data files, no real HTML, no forbidden literals (a colon-separated list of files) in the repo; never writes the DATA or STATE roots. |
| `SessionStart` hook | Seeds one task per declared stage (`Stage i/N: name`), plus one per open incident that blocks its stage. |
| `SubagentStop` / `TeammateIdle` hooks | Keep the `run-steward` working while any incident is unacknowledged. |
| `PreCompact` hook | Asks the compaction summary to keep the open incident ids. |
| `run-status` monitor | One line per run transition and per new incident, naming the files that hold the truth. |
| Agents | `pipeline-engineer` (fixes forward, with tests), `analyst` (one schema-checked finding, read-only), `run-steward` (read-only watcher). |
| Skills | `runbook-stop`, `runbook-approve`, `runbook-resume`, `runbook-reparse`, `site-recon`. |
| Workflow | `/scrape-harness:plan-pipeline` — three independent stage plans, deterministic rule checks, adversarial review, one judged `pipeline.toml` draft. It plans; it never fetches. |

Every gate fails **closed** on a broken or missing `pipeline.toml`; the context-only hooks (session,
steward, compaction) fail open on an internal error, so they never block a compaction or trap an agent.

**Site overlay.** A project whose `pipeline.toml` sets `[consumer] site_overlay = true` keeps its site
specifics (`default_site`, `default_region`, `site_hosts`, `[plugins]` `sources`, `python_path` and
`schema_dirs` (a site's own source code and record schemas; the harness resolves these paths against the
site file's folder), `[crawl] proxy` and `refresh`) in a site file outside the repo: `$<PREFIX>_SITE_CONFIG`, else `$<data_env>/config/site.toml`,
under `[pipeline.*]` tables. The guard merges only those keys (any other key under `[pipeline.*]` blocks).
When that file is unreadable, the Bash gate refuses the network commands and direct HTTP clients (it cannot
tell the site's hosts) and lets everything else through. A project without `site_overlay` is unaffected.

## Requirements and version skew

The project runs a pipeline built on the `scrape_harness` Python core and holds a `pipeline.toml`
at its root (or names it in `SCRAPE_HARNESS_PIPELINE`). The project's generated
`.claude/settings.json` enables this plugin and carries the deny rules a plugin cannot ship.

This plugin auto-updates from the marketplace; a project pins its core. When they disagree, the
hooks refuse with **"plugin/harness version mismatch"** and name the update to run: a key the plugin
does not know means the plugin is older; a key it needs and cannot find means the core is older.

Python 3.11+ (`tomllib`) on `PATH` as `python3`; the hook entry point fails closed without it.
