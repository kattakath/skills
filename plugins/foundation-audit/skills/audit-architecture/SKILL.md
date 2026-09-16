---
name: audit-architecture
description: >-
  Lane 1 of the four-dimension foundation audit — architecture, layering and
  boundaries, including the violations structural linters STRUCTURALLY CANNOT see:
  a value smuggled across a layer via specialArgs, an overlay, a string-interpolated
  path, or a runtime-built store path. Also god-file seams, where naming what must
  stay FUSED matters as much as naming what splits. Use when running the foundation
  audit, or when asked directly "does this repo's layering actually hold", "what
  boundary violations would a linter miss", or "which of these big files should be
  split". Returns findings, a CONFIRMED-SOUND list, and mandatory UNKNOWNS.
---

# Lane 1 — architecture, layering, boundaries

You are **one of four parallel lanes**. Stay in yours; the other three are covered and
duplicating them wastes the run.

| Lane | Owns | You report it? |
|---|---|---|
| **1 — you** | layer map, boundary edges, invisible channels, god-file seams | ✅ |
| 2 — duplication | two executables for one job, one fact in two places, custom code upstream ships | ❌ |
| 3 — validation | how each mutating step fails, blast radius, recovery | ❌ |
| 4 — dead surface | unread options, unreachable outputs, rules matching nothing, doc drift | ❌ |

**Arbitration at the seams** — these look like yours and are not:

- Custom code that duplicates an upstream option → **lane 2**, even though it is arguably a
  layering failure.
- A doc that describes the architecture *wrongly* → **lane 4**.
- An option declared and never read → **lane 4**. An option read **across a boundary the layer
  map forbids** → **yours**.

## Before anything: calibrate

Read [`../../references/calibration.md`](../../references/calibration.md) in full, and the
orchestrator's brief. C6 and C7 decide half your output: "oversized" is relative to *this*
repo's median, and anything a gate already catches is not a finding.

## Step 1 — build the intended layer map from the repo's OWN documentation

**Do not invent a layering.** Find the one the repo asserts — in `CLAUDE.md`, an ADR, a
`docs/repo-map.md`, an `ast-grep` rule, a lint config, a directory-naming scheme. Write it down
as a table of *who may reach whom*:

```
engine/parts     -> may reach anywhere
features/<x>     -> may reach ONLY inside its own directory        [asserted: ast-grep rule R]
shared/          -> may reach DOWN only (never into a feature)     [asserted: CLAUDE.md § …]
hosts/           -> composes; holds deltas, never a second identity
```

Then note, for each edge, **which gate enforces it and how**. That column is what tells you where
to hunt: *the gates enforce the import graph, so every violation that survives is one that is not
an import.*

If the repo asserts no layering at all, say so as a finding (SEV-2 or SEV-3 by how large the
tree is) and infer the *de facto* map from the directory structure before continuing.

## Step 2 — hunt the channels a structural linter cannot see

This is the lane's real product. A linter reads `import`/`imports` edges. **Every one of these
moves a value across a boundary without creating one.**

### 2a. Argument smuggling — `specialArgs` / `extraSpecialArgs` / `_module.args`

A module receives a value as a *function argument*. There is no import edge; the name simply
appears in the argument set. A capsule that is forbidden to reach out can still receive the whole
engine this way.

```bash
grep -rn 'specialArgs\|extraSpecialArgs\|_module\.args' --include='*.nix' .
```

For each: **list exactly what is threaded, and ask which layers are now coupled to it.** A single
`identity` attrset threaded everywhere is a deliberate design (check the ADR — C4). A module
reaching into `osConfig`, `nixosConfig`, or the whole `inputs` set is a different claim:

```bash
grep -rn 'osConfig\|nixosConfig\b' --include='*.nix' .     # home-manager reaching UP into the system
grep -rn '\binputs\b\s*\.' --include='*.nix' modules/features/ 2>/dev/null   # a capsule reading the flake's inputs
```

### 2b. Overlays — a global mutation with no edge

`nixpkgs.overlays` is the widest channel in a Nix repo: one module changes `pkgs` for **every**
consumer, forever, invisibly.

```bash
grep -rn 'nixpkgs\.overlays\|final:\s*prev:\|self:\s*super:\|overrideAttrs\|\.override\b' --include='*.nix' .
```

An overlay declared **inside a leaf module or a capsule** is a boundary violation almost by
definition — the leaf is mutating the root. Report what it changes and who else consumes that
package.

### 2c. Strings interpolated into paths

A path built from a string has **no import edge until the string is substituted**, so nothing
structural follows it. This is the shape that shipped one repo's personal host to strangers
(worked example 3).

```bash
grep -rn '\.\./.*\${' --include='*.nix' .
grep -rn 'import (\|import ("' --include='*.nix' .
```

Ask of each: *does this index the provider's own tree using a name the consumer supplied?*

### 2d. Runtime-built store paths

`writeShellApplication`, `writeText`, `runCommand`, `substituteAll`, a rendered config — the
embedded reference is a **string at eval time**, so the dependency is real at runtime and
invisible to any import-graph tool.

```bash
grep -rn 'writeShellApplication\|writeShellScript\|writeText\|runCommand\|substituteAll\|pkgs\.writers' --include='*.nix' .
```

Report where such a script reaches into another layer's paths, labels or options.

### 2e. Override pressure across a boundary

`lib.mkForce` / `mkOverride` / `mkBefore` used by a **lower** layer to overrule a decision an
**upper** layer made is a boundary inversion, and it is silent: the build is green and the upper
layer's declaration simply stops meaning anything.

```bash
grep -rn 'mkForce\|mkOverride\|mkBefore\|mkAfter' --include='*.nix' .
```

Each is legitimate when it overrides an **upstream** default and documented; report the ones
that override the repo's **own** upper layer.

### 2f. Escape hatches

```bash
grep -rn 'builtins.getFlake\|builtins.getEnv\|--impure\|allowUnfree\|readFile\|builtins.exec\|import <' --include='*.nix' .
```

Impurity is not automatically a finding — an escape hatch that a *published* artifact depends on
is.

## Step 3 — god-file seams, with the fused column

For every file above the repo's **p90** by line count (from the brief — not a number you brought
with you), produce **one table with three columns**. The third is mandatory:

| File | Splits cleanly into | **Genuinely cohesive — must stay FUSED** | Why fused |
|---|---|---|---|
| `hosts/macos.nix` (929) | the Homebrew cask list; the runner lanes | the account block: `users.users.<x>` + `users.knownUsers` + the `dseditgroup` activation | `knownUsers` is the create/**delete** switch; split them and a later edit deletes an account silently |

**A split proposal with no fused column is a make-work list**, and the orchestrator should reject
it. Naming what must not move is the part a maintainer cannot get anywhere else.

### The cohesion test

> Two things must stay fused if changing one without the other yields a **silently wrong**
> system — not a build error.

A build error is a safety net; the compiler will catch the split. Silence will not. Classic fused
pairs:

- an option declaration and the single place that reads it (split → a dead option, lane 4's
  problem, created by you)
- a launchd/systemd **label** and every script that references it by name
- a port/socket path and both ends of it
- a create switch and the thing it creates
- an ordering constraint expressed only by adjacency in a concatenated script

## Step 4 — the consumer's view

If the repo publishes anything a stranger consumes — a template, a library function, an example,
a `lib.*` API, a starter — **evaluate it as a stranger** and ask what it materialises. Accounts,
packages, services, credentials, hostnames. This is where lane 1's SEV-1s live.

## Output

Exactly the three sections in [`../../references/report-format.md`](../../references/report-format.md):
`## FINDINGS` (ranked, each with what / evidence `file:line` / why it matters for a foundation /
fix / size), `## CONFIRMED-SOUND`, `## UNKNOWNS`.

Lane-1-specific reminders:

- **CONFIRMED-SOUND**: name every boundary you checked and found held, and every big file you
  decided is *correctly* big. "`modules/features/x` reaches nothing outside itself — verified
  across 11 files" is exactly the sentence that stops the next agent re-auditing it.
- **UNKNOWNS**: anything you could not evaluate. If `nix` was unavailable, every claim about what
  a configuration *materialises* is reading, not measurement — say so.
