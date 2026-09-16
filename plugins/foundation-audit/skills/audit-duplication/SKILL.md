---
name: audit-duplication
description: >-
  Lane 2 of the four-dimension foundation audit — duplication and redundancy judged
  by PURPOSE, not by text. Three hunts: two executables for the same job even when
  they share no code; one fact (a port, a path, a label, a URL, a UID) declared in
  two places that can silently disagree; and custom code that an upstream dependency
  already ships, proved by grepping the PINNED input's option surface and citing the
  result. Use when running the foundation audit, or when asked "what is redundant
  here", "are we reinventing something upstream has", or "where can these two configs
  drift apart". Returns findings, a CONFIRMED-SOUND list, and mandatory UNKNOWNS.
---

# Lane 2 — duplication and redundancy, by purpose

You are **one of four parallel lanes**. Stay in yours.

| Lane | Owns | You report it? |
|---|---|---|
| 1 — architecture | layer map, boundary edges, invisible channels, god-file seams | ❌ |
| **2 — you** | one job / two executables, one fact / two declarations, custom code upstream ships | ✅ |
| 3 — validation | how each mutating step fails, blast radius, recovery | ❌ |
| 4 — dead surface | unread options, unreachable outputs, rules matching nothing, doc drift | ❌ |

**Arbitration at the seams:**

- A duplicated fact that appears in a **doc** as well as in code → still **yours** (it is one
  fact in two places). A doc that is merely *wrong* → lane 4.
- One of two redundant entry points is **unreachable** → lane 4 owns the unreachability, you own
  the redundancy. Say so; the orchestrator will merge.
- Custom code duplicating upstream → **yours**, not lane 1's, even though it is arguably layering.

## Before anything: calibrate

Read [`../../references/calibration.md`](../../references/calibration.md). **C5 decides this
lane's rubric**: whether "custom code upstream already ships" is a finding at all depends on the
repo's stated motto. Read it before D3.

## The rule that governs the whole lane

> **Judge by purpose, not by text.**

A near-duplicate-text linter is a solved, cheap problem and the repo probably runs one. You are
here for what it cannot see:

| Text | Purpose | Verdict |
|---|---|---|
| identical | identical | the linter has it — **not your finding** (C7) |
| **different** | **identical** | ✅ **your primary hunt** — two ways to do one job |
| identical | different | usually fine; coincidence, not coupling |
| different, one line | **two purposes in one place** | ✅ worse than duplication — report it |

## D1 — two executables for the same job

**Method:** enumerate *every* entry point, then cluster by **the job a user is trying to do**,
not by implementation.

```bash
# every entry point, whatever its shape
nix flake show --json 2>/dev/null | jq -r '.apps,.packages | .. | objects | keys?' 2>/dev/null
ls scripts/ bin/ 2>/dev/null
ls .claude/commands/ .claude/skills/ 2>/dev/null
grep -rn 'writeShellApplication\|mainProgram\|meta.mainProgram' --include='*.nix' .
grep -rn 'aliases\|shellAliases\|programs\..*\.aliases' --include='*.nix' .
```

Then write the cluster table, framed as **what the operator would type**:

| Job the operator wants done | Ways to do it | Verdict |
|---|---|---|
| activate this machine | `darwin-rebuild switch --flake .#x`, `nix run .#activate`, `/hygiene` step 4 | three; two documented, one not |

**Two names for one job is a finding even when the code shares nothing** — arguably *especially*
then, because they will drift and nothing will notice. Rank it by the cost of picking the wrong
one: SEV-2 if the two do subtly different things, SEV-3 if they are genuinely interchangeable.

The commonest shapes: a script and a flake app that wrap the same command; a `Makefile` target
and a `just` recipe; a slash command and a skill that both own a workflow; a CI step and a local
script that must stay in step.

## D2 — one fact, two declarations (the silent-disagreement hunt)

**This is the highest-yield hunt in the lane**, because the two copies are usually in different
*languages* — Nix, JSON, YAML, a shell script, a Markdown doc — which is exactly why no single
linter sees both.

Facts that have this shape: **a port, a socket path, a data directory, a launchd/systemd label, a
hostname, a URL, a UID/GID, a username, a version string, a package name, a timeout, a cache
name, a branch name.**

**Method** — take each literal that *configures* something, and grep the whole tree for its value:

```bash
# ports, and the files that carry them
grep -rnoE ':[0-9]{4,5}\b|port\s*=\s*[0-9]+|PORT[=:][0-9]+' . --include='*' \
  | grep -v '\.git/' | sort | uniq -c | sort -rn | head -40

# hostnames and URLs
grep -rnoE 'https?://[a-zA-Z0-9.-]+' . --include='*' | grep -v '\.git/' \
  | awk -F: '{print $NF}' | sort | uniq -c | sort -rn | head -30

# launchd / systemd labels, referenced by name from scripts
grep -rnoE '[a-z0-9-]+\.[a-z0-9-]+\.(plist|service)|Label.*=.*"' --include='*.nix' --include='*.sh' .

# uids, usernames, absolute home paths
grep -rnE '\buid\s*=\s*[0-9]+|/Users/[a-z]+|/home/[a-z]+' --include='*.nix' --include='*.json' .
```

For every value appearing in **≥2 files**, decide: is one derived from the other (an
interpolation, an option read, a generated file), or are they **two independent literals**? Only
the second is a finding.

```
FINDING shape:  `8096` is declared at modules/shared/mcp.nix:41 and again at
                docs/mcp-gateway.md:18 and .claude/settings.json:92 — three independent
                literals. Changing the module does not change the other two, and nothing
                fails when they disagree; the symptom is a client that cannot connect.
FIX shape:      one source; the others interpolate or are generated from it. If a file
                genuinely cannot interpolate (a doc, a foreign-tool JSON), the fix is a
                CHECK that asserts equality — or a dated comment naming the twin.
```

**Rank by silence, not by count.** Two copies of a port that fail loudly when they disagree is
SEV-3. Two copies where disagreement produces a *working system doing the wrong thing* is SEV-1.

## D3 — custom code that upstream already ships

**Only a finding if the repo's own motto makes it one (C5).** Where it does, the standard is
strict, and it is a standard about *evidence*, not about opinion:

> **Grep the PINNED input's option surface and cite the result line.**
> "I did not find one" is only acceptable with the search shown.

```bash
# the pinned inputs' store paths — this is the version actually in use
nix flake metadata --json 2>/dev/null | jq -r '.locks.nodes | to_entries[] | "\(.key)"'
# search a pinned input's options for the thing being hand-rolled
grep -rn 'mkOption' /nix/store/*-source/modules/ 2>/dev/null | grep -i '<the concept>'
# nixpkgs / home-manager / nix-darwin option search, if available
nix eval --raw '.#darwinConfigurations.<host>.options' 2>/dev/null
```

Non-Nix equivalent: read the pinned dependency's own docs/source for the feature, at the pinned
version — **not** the latest docs on the web, which is how this check produces false positives.

Report as:

```
Custom: modules/shared/foo.nix:22-61 (39 lines) re-implements <X>.
Upstream: <pinned-input>/modules/bar.nix:118 declares `services.bar.x` which does the same.
Delta: upstream lacks <Y> (which this repo needs) / upstream covers it entirely.
```

**Include the delta honestly.** Most hand-rolled code exists because upstream was 90% right.
A finding that ignores the missing 10% gets rejected and costs the whole report credibility.

## What is NOT this lane's finding

- **Text-level near-duplicate blocks serving two different purposes.** Two similar-looking
  modules that do different jobs are fine, and merging them is how a repo gets a god-file — which
  lane 1 will then report. You would be manufacturing lane 1's work.
- **Deliberate duplication with a stated, dated reason.** (C4.) Example from the run this was
  extracted from: two encrypted files holding *identical key material on purpose*, because the
  decrypting users differ. Quote the reason, verify it still holds, and put it in
  **CONFIRMED-SOUND**.
- **Repetition that a config format requires.** Some formats have no interpolation. Say so.

## Output

The three sections from [`../../references/report-format.md`](../../references/report-format.md).

Lane-2-specific reminders:

- **CONFIRMED-SOUND**: list the facts you checked and found to have **exactly one source**, and
  every deliberate duplication whose reason holds. This is the section that stops a future agent
  "de-duplicating" something load-bearing.
- **UNKNOWNS**: every literal you could not trace to a single source but could not prove
  independent either; and any upstream surface you could not search (input not realised, docs
  offline, version ambiguous).
