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
| `SessionStart` hook | Seeds one task per declared stage (`Stage i/N: name`), plus one per open incident that blocks its stage, and adds one status line read from `STATE/status.json` and the incident record: the latest run (id, stage, status), the open incident ids with their exit codes, and which are cooldowns or breaker latches. At most 1500 characters; no path, no env value. |
| `SubagentStop` hooks | Each contracted agent must end with ONE schema-checked object (`<cli> validate <contract> -`): `analyst` a `finding.v1`, `run-steward` a `run_report.v1`, `pipeline-engineer` a `diagnosis.v1`. A requested change, where nothing broke, is `diagnosis.v1` with `kind: "change"`: no root cause or evidence is forced. An invalid answer comes back once with the errors. |
| `SubagentStop` / `TeammateIdle` hooks | Keep the `run-steward` working while any incident is unacknowledged, whatever it answers. |
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

**The task seed needs the task tools, and they are often off.** The `SessionStart` seed asks for one
`TaskCreate` per stage. Claude Code's
[tools reference](https://code.claude.com/docs/en/tools-reference.md#task-tool-availability) says the task
tools "are available by default only on Opus 4.7, Sonnet 4.6, Haiku 4.5, and earlier models. … On every
other model, Claude Code leaves the tools out unless you opt in."
- **To get the task list:** export `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` before starting Claude Code. That
  matters on any machine without it set globally: CI, a devcontainer, a teammate's laptop. A plugin
  cannot set it.
- **Without it the seed still works:** it tells the session to list the stages as a numbered checklist in
  its reply instead (`test_the_seed_degrades_when_task_tools_are_off`).
- Background and cloud sessions get the tools on every model, per the same page.

This plugin auto-updates from the marketplace; a project pins its core. When they disagree, the
hooks refuse with **"plugin/harness version mismatch"** and name the update to run: a key the plugin
does not know means the plugin is older; a key it needs and cannot find means the core is older.

The agent contracts skew the other way. A core pinned before `run_report.v1` or `diagnosis.v1` answers
`unknown contract '<name>'` (exit 1). The SubagentStop gate then lets the agent stop, with one line
naming the update (`nix flake update scrape-harness`). It never traps the agent. An invalid object
(exit 2) and anything else still block.

Tests: `bash plugins/scrape-harness/tests/run.sh` (stdlib, a synthetic consumer and a stub CLI). The
core's own suite drives the same hooks against the real CLI.

The core's `<cli> claude-md` routes by the "Use when / whenever / before ..." clause of every skill and
agent description, and refuses when one has none. The tests check each description has that clause and
that the operator's phrases sit inside it. They cut the clause with the core's own regex; the core's suite
checks the two are equal.

Python 3.11+ (`tomllib`) on `PATH` as `python3`; the hook entry point fails closed without it.
