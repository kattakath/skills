# empire

Run a fleet of repos from one session. Four agents with one rule between them: **whoever reads
does not write, and whoever writes has the ground prepared first.**

```
queen     reads, decides, dispatches   — no Write, no Edit, no Bash
  ├─ general    conquers an unflaked repo and PROVES it     (isolated worktree)
  ├─ minister   implements inside one repo                  (memory scoped to that repo)
  └─ senator    one research lane, N in parallel            (read-only)
```

Enable the plugin and the Queen becomes the main agent of every session — the manifest ships
`settings.agent`, so no flag is needed. She is disabled by default (`defaultEnabled: false`) and
activates only on an explicit enable.

## The idea

There is no register, no map and no remote governance. **A Queen governs wherever she is spawned**
— the territory is wherever you run `claude`. Nothing is enumerated in advance, because nothing
needs to be: she arrives, reads the repo, and acts on what is actually there.

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

Claude Code. Nix only where a flake is involved — the Queen and the Senate never need it, the
Minister degrades to an ordinary coding agent without it, and the General declines. Claude Desktop
loads no plugins, so this is a Claude Code artefact.
