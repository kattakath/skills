---
name: audit-validation
description: >-
  Lane 3 of the four-dimension foundation audit — validation, failure modes and blast
  radius. Classifies every activation, setup, bootstrap and deploy step into four
  buckets: cannot-fail, fails loud-and-early, fails MID-WAY leaving mixed state, or
  fails SILENTLY. The last two are the findings, and the silent one is where the real
  damage lives (an upstream `exit 0` inside a concatenated activation script ends the
  WHOLE script reporting success). Read-only: it never runs an activation, and says so
  in UNKNOWNS. Use when running the foundation audit, or when asked "what happens if
  this half-applies", "can this fail without telling me", or "what is the blast radius".
---

# Lane 3 — validation, failure modes, blast radius

You are **one of four parallel lanes**. Stay in yours.

| Lane | Owns | You report it? |
|---|---|---|
| 1 — architecture | layer map, boundary edges, invisible channels, god-file seams | ❌ |
| 2 — duplication | one job / two executables, one fact / two declarations, custom vs upstream | ❌ |
| **3 — you** | how every mutating step fails, what state it leaves, who it hurts, how to recover | ✅ |
| 4 — dead surface | unread options, unreachable outputs, rules matching nothing, doc drift | ❌ |

**Arbitration at the seams:**

- A **rule that matches nothing** → lane 4. A **step that fails silently** → yours. A rule that
  was supposed to *prevent* a silent failure and does not match → both; say so, the orchestrator
  merges.
- A doc that describes recovery **wrongly** → lane 4 (a reader would act on it). A recovery path
  that does not exist at all → yours.

## Before anything: calibrate

Read [`../../references/calibration.md`](../../references/calibration.md). **C2 and C3 are
load-bearing here**: a `${pkgs.foo}/bin/foo` cannot be missing at runtime (never flag it), a bare
command name or a non-store absolute path can (flag it), and a line number into a *generated*
activation script rots — cite it by grep anchor.

## THE HARD RULE: you read, you do not run

**Never execute an activation, a `switch`, a deploy, a bootstrap, or anything that mutates state
outside the repo** to see how it fails. That is the whole reason this lane produces UNKNOWNS
rather than test results.

Reading the **built artifact** is not running it, and you should:

```bash
wc -l /run/current-system/activate 2>/dev/null        # the composed script, as built
sed -n '1,120p' /run/current-system/activate          # read it; do not execute it
systemctl cat <unit> 2>/dev/null                      # rendered unit, not started
nix build .#<output> --dry-run                        # plan only
```

Anything you would have had to run goes in **UNKNOWNS**, naming the command you did not run.

## Step 1 — enumerate every step that MUTATES

Build the inventory first; classify second. Miss a step and the classification is worthless.

```bash
grep -rn 'system\.activationScripts\|home\.activation\|activationScripts\.' --include='*.nix' .
grep -rn 'launchd\.\(agents\|daemons\|user\)\|systemd\.services\|systemd\.user\.services' --include='*.nix' .
grep -rn 'postInstall\|preStart\|postStart\|ExecStartPre\|postBuild' --include='*.nix' .
ls bootstrap* install* setup* scripts/ 2>/dev/null
grep -rn 'apps\.\|mkApp\|writeShellApplication' --include='*.nix' . | head -40
ls .github/workflows/ && grep -rn 'run:' .github/workflows/ | grep -iE 'deploy|switch|push|apply|publish'
```

Include: activation snippets, launchd/systemd units, `*-init` scripts, bootstrap/curl-to-shell
installers, flake apps that mutate, IaC apply steps, CI deploy jobs, git hooks, editor hooks,
`postCreateCommand`s. **Anything that writes outside `/nix/store` or `.git`.**

## Step 2 — classify each step into exactly one bucket

**The classification IS the product.** Deliver it as a table covering *every* step, not just the
bad ones — the good rows are your CONFIRMED-SOUND.

| Bucket | Definition | Finding? |
|---|---|---|
| **A — cannot fail** | pure eval, or a symlink the builder already materialised. No runtime decision | no |
| **B — fails loud and early** | exits nonzero **before any mutation**, and the message names the cause | no |
| **C — fails MID-WAY** | mutates, then fails. Part applied, part not. Re-running is not a no-op | ✅ **finding** |
| **D — fails SILENTLY** | exits 0 without doing the job, or the failure is swallowed | ✅ **finding, highest severity** |

Four questions decide the bucket, in order:

1. **Does it mutate anything outside the store?** No → A.
2. **Can it fail *after* the first mutation?** No → B.
3. **Does a failure reach a human — nonzero exit, a message they will see?** No → **D**.
4. Otherwise → **C**.

### The silent-failure tells (bucket D) — grep list

This is the lane's highest-value half hour.

```bash
# 1. `exit` inside a snippet that gets CONCATENATED into a bigger script  <-- the big one
grep -rn '^\s*exit\b\|exit 0' --include='*.nix' --include='*.sh' .
grep -rn 'exit 0' /nix/store/*-source/modules/ 2>/dev/null      # upstream snippets too
# 2. swallowed status
grep -rn '|| true\|||\s*:\s*$\|set +e\|2>/dev/null' --include='*.nix' --include='*.sh' .
# 3. background, so the status belongs to the launcher
grep -rn '&\s*$\|nohup\|disown\|setsid' --include='*.nix' --include='*.sh' .
# 4. traps that exit clean
grep -rn 'trap ' --include='*.nix' --include='*.sh' .
# 5. conditionals whose false branch is silent
grep -rn 'if \[\|if command -v\|\[\[ -' --include='*.sh' --include='*.nix' . | head -40
```

Then reason about each:

- **`exit` in a concatenated snippet ends the WHOLE script, successfully.** Read the composer to
  confirm the concatenation and the slot **order** — everything after that slot never runs. This
  is worked example 1; read it.
- **`|| true` is a decision to ignore an outcome.** Legitimate when the outcome genuinely does
  not matter; a defect when it hides the one thing that could go wrong. Ask what the command
  *was for*.
- **A pipeline under `set -o pipefail` can fail on SUCCESS**: `cmd | grep -q x` returns **141**
  (SIGPIPE) when `grep -q` matches and closes the pipe early. The guard passes by hand and fails
  in situ — check for `pipefail` at the top of the composed script before blaming the command.
- **A unit that fails *after* activation returns**: the step reports success, the service is dead.
  Ask for every agent/service: *is its health checked by anything, ever?* Usually the answer is
  no, and that is a real bucket-D finding.
- **A conditional with a silent false branch** — `if command -v x; then …; fi` with no `else` —
  is a skip nobody is told about.

### The mid-way tells (bucket C)

- **Two or more mutations with no transaction.** Write A, then write B; if B fails, A stands.
- **Non-idempotent writes**: append rather than replace, `mkdir` without `-p`, a counter, a
  one-way migration.
- **Order dependence expressed only by adjacency** in a concatenated script.
- **A partial write that a later run treats as complete** — the worst variant, because re-running
  does not repair it.

## Step 3 — blast radius, per step

For each bucket-C and bucket-D step, state **who is affected**:

| Radius | Meaning |
|---|---|
| this machine, recoverable | roll back a generation and it is gone |
| this machine, **needs hands** | a bricked boot, a corrupted card, a lost keychain entry |
| **a live remote host** | a server mid-deploy — and whether the deploy has an auto-revert (a watchdog / magic rollback) that actually covers *this* step |
| **every consumer of this repo** | a template, a published library, a pinned input |
| **a shared secret or credential** | a token that leaked, was rotated half-way, or is now in two states |

And then the recovery question, which is the one people skip:

> **Does the stated rollback actually cover this step?**

Generation rollback covers *declared* state. It does **not** cover: an imperative `dseditgroup`,
a file written to `$HOME`, a remote API object created by an apply, a rotated credential, a
formatted disk, anything a launchd agent did while it was alive. Name each one that escapes
rollback — those are SEV-1 regardless of how unlikely they are.

## Step 4 — idempotence

Cheapest useful property, and you can often establish it by reading. For each step say
**proven idempotent by reading / proven NOT idempotent / could not decide**. The third is an
UNKNOWN, not a finding — and it is exactly the kind you must label rather than guess.

## Output

The three sections from [`../../references/report-format.md`](../../references/report-format.md),
**plus the full classification table** (every step, its bucket, its radius) inside
CONFIRMED-SOUND for buckets A and B.

Lane-3-specific reminders:

- **CONFIRMED-SOUND** is your bucket-A/B table. "These 14 steps fail loudly before mutating, here
  is each one" is a genuinely valuable artifact and nobody else in the run produces it.
- **UNKNOWNS must name the commands you did not run**, and why: *"Not tested: whether `activate`
  is idempotent on a second run — establishing it requires RUNNING an activation, which mutates
  this machine."* A labelled gap beats a confident guess.
