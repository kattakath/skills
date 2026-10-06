# empire

Three surfaces for running work across repos, with one rule between them: **whoever reads does
not write, and whoever writes has the ground prepared first.**

```
general    conquers an unflaked repo and PROVES it     (isolated worktree)
minister   implements inside one repo                  (memory that outlives the session)
senate     N read-only research lanes, in parallel     (a deterministic workflow)
```

**There is no controller agent.** The session's main agent — you, or whatever the operator is
already running — does the dispatching. Earlier versions shipped a `settings.agent` key that made
a write-less "Queen" the main agent of every session; that is removed. A controller that cannot
run a command cannot verify what it forwards, and every trivial task became a cold subagent that
re-read the repo from nothing.

## Dispatch — goal to surface

| The goal | Send |
|---|---|
| A change needs making in a repo | `empire:minister` (conquest first if the repo has no `flake.nix`) |
| No `flake.nix`, and a change is needed | `empire:general` — he prepares the ground, then the minister works |
| One repo, one goal, discipline held across interruptions | `/brain-signals:task`, which can then dispatch the minister |
| A decision needs parallel research | `/empire:senate` |
| "Is this repo solid enough to build on?" | `foundation-audit` |
| The session lacks a capability it needs | `capability-broker` |
| "Has someone already solved this?" | `prior-art-recon` |

Two standing rules behind that table:

- **Conquest is triggered by writing, never by reading.** A repo earns its `flake.nix` on the
  first need to *change* it. Research and audits read freely in unconquered ground.
- **Delegate, never reimplement.** The flake template lives in `nix-dev-toolkit`. The audit
  dimensions live in `foundation-audit`. If a sibling owns a job, calling it is the only correct
  move.

## The Senate is a workflow, not a prompt

`/empire:senate` is `workflows/senate.js` — a deterministic script, not an agent deciding how
many helpers to spawn. It takes a question and a lane list, dispatches one `empire:senator` per
lane concurrently, and hands every report to one synthesis stage.

```
/empire:senate   args: {"question":"<the decision>",
                        "lanes":[{"name":"...","question":"...","instrument":"..."}, ...]}
```

- **Fewer than two lanes and it refuses**, telling you what to run instead. One lane is a lookup.
- Each lane returns a **validated object** — `verdict`, `measured[]`, `cited[]`, `assumed[]`,
  `negative_searches[]`, `weakest_assumption` — so the labelling discipline is machine-checked
  rather than hoped for.
- The lane prompt states that **a verdict of NO is the most valuable outcome**, and that the
  instrument named in a brief is a **hypothesis, not an instruction**.
- `agentType: "empire:senator"` means `agents/senator.md` remains the lane discipline. The script
  contributes the fan-out and the schema, and reimplements none of the Senator's rules.
- The synthesis stage runs as `empire:consul` — **`Read, Grep, Glob` only.**

### Why the Consul holds nothing dangerous

The lanes hold `WebSearch` and `WebFetch`, so a lane report can contain **arbitrary text from a
page someone else controls**. That report is then handed to the synthesis stage. If synthesis ran
unconfined — which is what happens when an `agent()` call names no `agentType` — fetched web text
would sit one sentence away from `Write`, `Edit` and `Bash`.

`agent()` has **no `tools` option**, so the agentType *is* the boundary. `agents/consul.md` has no
Write, no Edit, no Bash and no network, and the prompt fences the payload between explicit markers
and restates the boundary **after** it, because injected text aims at the tail of a prompt. The
prose is defence in depth; the tool list is the defence.

**The fence is unforgeable by construction, and was not at first.** `JSON.stringify` escapes quotes
and newlines but **not** arbitrary ASCII, so the original wrapper let a lane report emit the END
marker verbatim — everything after it then read as though the script had written it. A fence a
forger can close is worse than no fence: it manufactures trust rather than merely failing to add
any. Now every run of four or more `=` in the payload collapses to `[=]` and the markers require
five, so the data cannot reproduce them. No nonce is used, because `Math.random()` and `Date.now()`
**throw** inside a workflow script and a nonce derived from the payload would be derived from
attacker-controlled bytes. `tests/senate-fence-cases.mjs` gates it in CI, reading the fence out of
`senate.js` rather than keeping a second copy.

**Residual risk, stated rather than hidden:** the Senators themselves hold `Bash` — needed for
their measurement role when invoked directly — while also fetching the web. Their confinement is
prose ("measurement only", "never mutate state"), not a tool boundary. A lane is therefore the
weaker link, and a Senate pointed at hostile sources should be read with that in mind.

**It appears only after the plugin is enabled.** `defaultEnabled: false`, and a disabled plugin
loads **no components at all** — no agents, no workflow. Worse, an `enabledPlugins` entry already
written to settings persists across updates, so the manifest key cannot re-enable it. `/empire:senate`
missing from autocomplete is therefore not evidence of a broken workflow; check that the plugin is
enabled first.

If workflows are switched off entirely (`disableWorkflows: true`, or
`CLAUDE_CODE_DISABLE_WORKFLOWS=1`), the command disappears and `empire:senator` is still there to
invoke directly — one lane at a time, prose report.

## Where the durable record lives

**The Minister's `memory: project`, at `.claude/agent-memory/empire-minister/` inside the repo
being worked on.** It is version-controlled: committed with the change, or it is a local file and
not a handover. Only the first 200 lines or 25KB of its `MEMORY.md` is injected automatically, so
that file is an index with links and the detail sits in siblings.

Two things that are **not** the record, and why neither makes the other redundant:

- **The workflow's resume cache is session-scoped.** It stops a completed lane re-running inside
  one session. It does not survive the session, so it is not a ledger.
- **Agent Teams' shared task list was the rejected alternative.** It lives at
  `~/.claude/tasks/{session-XXXXXXXX}/` — outside the repo, named from the session id, swept by
  `cleanupPeriodDays`, one team per session and not shareable across sessions. A within-session
  coordination surface, not a project record.

The General deliberately has no `memory:` key: `isolation: worktree` means its files would land in
a worktree that is removed when unchanged, so the memory would appear to work and then vanish.

## Conquest

A repo earns a `flake.nix` on the **first need to change it**. Reading leaves no footprint; a
change means you intend to maintain the place, and maintenance needs a feedback loop.

The General does that work, and his deliverable is **a verified flake, not a flake** — three
checks that can each genuinely fail:

| Check | Fails when |
|---|---|
| `formatting` | the tree is not formatted |
| `toolchain-complete` | the devShell promises a binary it does not deliver |
| `project-gate` | the project is broken — *required where a test command exists, recorded absent where none does* |

A check that cannot fail is not a check. `checks = <the packages, aliased>` goes green by
construction and proves only that what builds, builds.

**Without Nix the General refuses** rather than writing a flake he cannot evaluate — an unverified
flake is worse than none, because it looks like a prepared repo and outlives the session that
could have explained it.

## Delegation, never duplication

The empire owns the dispatch and the standard. It owns none of the tools:

| Need | Goes to |
|---|---|
| a flake | `nix-dev-toolkit` — owns the template; nobody writes a flake from memory |
| is this repo solid? | `foundation-audit` |
| we lack a capability | `capability-broker` |
| has someone already built this? | `prior-art-recon` |

Only `nix-dev-toolkit` is a hard dependency — the General cannot do his job without it. The rest
are routing targets, so a missing one degrades a route rather than demoting the plugin.

## What this plugin does NOT do

**Permissions.** What any agent may do is a property of the machine, not of this plugin — it
belongs in the operator's own settings floor, where the session being governed cannot edit it.
No agent here uses `bypassPermissions`.

## Requirements

Claude Code. Nix only where a flake is involved — the Senate never needs it, the Minister degrades
to an ordinary coding agent without it, and the General declines rather than writing a flake he
cannot evaluate. Claude Desktop loads no plugins, so this is a Claude Code artefact.
