# silent-instruments

**When exit 0 means "I measured nothing."**

A measured catalogue of instruments that return something which *looks like* evidence while
having measured nothing, or the wrong thing — plus a `PostToolUse` advisory that names the
cross-check, and two test suites that keep both honest.

## What it ships

| Piece | What it is |
|---|---|
| `skills/silent-instruments/SKILL.md` | the protocol, and a nine-row reflex table keyed by the claim you are about to make |
| `skills/silent-instruments/references/catalogue.md` | 28 entries across shell, git and the GitHub API — trap, why it is silent, the correct instrument, and whether it was measured or documented |
| `skills/silent-instruments/tests/trap-cases.sh` | **55 assertions** proving the catalogue's shell and git entries, both halves: the naive instrument returns the wrong answer, the named replacement returns the right one |
| `scripts/silent-instrument-lint.js` + `hooks/hooks.json` | a `PostToolUse:Bash` advisory, 13 rules, each naming its catalogue entry |
| `tests/lint-cases.sh` | **48 assertions** for the hook: must-FLAG, must-stay-QUIET, never-throw |

## What it deliberately does NOT ship

**A verification discipline.** That already exists and is better than anything written here
would be: `verification-before-completion` in [obra/superpowers](https://github.com/obra/superpowers)
(MIT, ~182k installs) carries the Iron Law — *"NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION
EVIDENCE"* — a five-step gate and a rationalization-prevention table. Adopt that; this plugin
sits **under** it.

The gap is precise. That gate's step 3 reads **"READ: Full output, check exit code"**, which
assumes the exit code you read is the command's and the output is complete. Every entry here is
a case where **the command ran, exited 0, and the output was wrong** — so running the gate
faithfully on a silent instrument still produces a confident falsehood. Verified by reading it:
the upstream skill is one file and mentions none of these instruments.

## Why a prose catalogue and not a linter

Because no linter can take the job. Measured 2026-10-02 with ShellCheck 0.11.0:

| Attempt | Result |
|---|---|
| ShellCheck on a zsh script | **refused** — `SC1071`, "only supports sh/bash/dash/ksh" |
| Stale `${PIPESTATUS[0]}` with `-o all` | **no diagnostic exists**; only `SC2312` on the pipe |
| `for f in $files` | **not** `SC2086` — an unquoted `for` list reads as deliberate splitting |

Zero of the nine failures that motivated this plugin. `shfmt` and `bashate` are formatters, and
ShellCheck never sees the inline command string an agent actually runs. Upstream declined the
agent-facing case too: `anthropics/claude-code` issue **#74888** names the zsh field-splitting
failure exactly and was **closed as not planned**.

## Why the hook is PostToolUse — a security decision, not a preference

`PreToolUse` cannot advise without taking a permission decision. Its `permissionDecision:
"allow"` is documented as *"Tool call proceeds without permission prompt"*, so a hook enabled in
every repo that used it would **bypass the user's own permission rules** on every command it
matched. `"deny"` blocks legitimate work; `"ask"` adds a prompt to every match; emitting
`additionalContext` with no decision is undocumented.

`PostToolUse` has no permission authority at all, and it is the better moment on the merits:
these are not dangerous commands, they are outputs about to be **misread**, and `PostToolUse`
fires between execution and interpretation. Exit discipline follows this repo's
`claude-code-nix` hooks — `2` surfaces the advisory and reverts nothing, `0` says nothing, and
any internal error exits `0` so an advisory can never wedge a turn.

**Noise is the real risk.** A rule that fires on ordinary work trains the reader to ignore the
channel, and an ignored channel protects nothing — so `tests/lint-cases.sh` asserts the
must-stay-QUIET half as carefully as the must-FLAG half, including every corrected form the
advisory recommends.

## The one rule

> **A measurement is not evidence until a second, differently-shaped instrument agrees.**

Not "run it again" — the same instrument repeats the same blindness. The named prior art is
**triangulation**, and in reliability engineering **N-version programming**: deliberate
diversity, so two instruments do not fail together.

## The catalogue earns its keep, and can be checked

Two entries were **dropped** for failing to reproduce rather than for being wrong in principle
(a stale-index false "dirty", and `git describe` on lightweight tags), and eight more were
rejected for being too *loud* to qualify — an agent cannot be confidently wrong about a
`fatal:`.

Then the test suite caught an error in the catalogue's own first draft. `${PIPESTATUS[0]}` was
documented as reading *empty* after an intervening command. It does not:

| Shell | Behaviour | Mechanism |
|---|---|---|
| bash | returns **`0`** | staleness is real, but it holds the *intervening* command's status — so it reads as **success**, which is worse than empty |
| zsh | **always empty** | there is no `PIPESTATUS`; it is `pipestatus`, and arrays are **1-indexed**, so `[0]` never exists — staleness is irrelevant |

One expression, two different bugs, neither announcing itself. That is why the assertions exist
and why a trap that stops reproducing is an entry to fix, not a test to delete.

## Running the tests

```bash
bash plugins/silent-instruments/tests/lint-cases.sh                               # the hook
bash plugins/silent-instruments/skills/silent-instruments/tests/trap-cases.sh      # the catalogue
SI_NO_ZSH=1 bash plugins/silent-instruments/skills/silent-instruments/tests/trap-cases.sh
```

The third line forces the zsh cases down their skip path, so the shape CI actually runs
(`ubuntu-24.04`, where zsh is absent) is exercisable from a machine that has zsh. Without it
those skip branches would ship untested — which is the shape of bug this plugin is about.
Measured both ways: **55 pass / 0 fail** with zsh, **49 pass / 0 fail / 2 skip** without.

## Requires

Nothing. `bash`, `git` and `node` for the tests; the suites skip `zsh` cases when zsh is
absent and never touch the network, so CI stays credential-free.
