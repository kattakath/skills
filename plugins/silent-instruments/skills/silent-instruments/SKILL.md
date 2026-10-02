---
name: silent-instruments
description: >-
  Use when about to state a finding that rests on a command's output — "did that actually
  work", "are you sure", "prove it", "verify that", "double-check", "that exit code looks
  wrong", "why did CI pass when nothing ran", "the branch looks unmerged", "the list came
  back empty", "it printed nothing so there is nothing there", "I declared it so it must be
  on", "why did my config change do nothing" — or when an exit 0, an empty
  result or a green status is about to become a claim. Covers the instruments that fail
  SILENTLY, the ones that exit 0 having measured nothing, so the output looks like evidence
  and is not.
version: 0.1.0
---

# Silent instruments — when exit 0 means "I measured nothing"

**What:** a catalogue of measurement instruments that return something which *looks like*
evidence while having measured nothing, or the wrong thing — plus the cross-check that catches
them. **When:** immediately before a command's output becomes a claim.

This skill is **the instrument layer under a gate it does not replace.** Use
`verification-before-completion` (obra/superpowers) for the discipline — its Iron Law
(*"NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE"*) and its five-step gate are the
right frame and are not restated here.

What that gate assumes is the gap this skill fills. Its step 3 reads:

> **READ:** Full output, check exit code

That assumes the exit code you read is the command's, and that the output is complete. Every
entry in [`references/catalogue.md`](references/catalogue.md) is a case where **the command ran,
exited 0, and the output was wrong.** Running the gate faithfully on a silent instrument still
produces a confident falsehood.

## The one rule

> **A measurement is not evidence until a second, differently-shaped instrument agrees.**

Not "run it again" — the same instrument repeats the same blindness. A *different shape*: a
count against a list, a content hash against an ancestry claim, job-level against run-level,
`command -v` against a `PATH` scan. The named prior art is **triangulation** and, in reliability
engineering, **N-version programming** — deliberate diversity so two instruments do not fail
together.

## Protocol

1. **Name the claim.** "Nothing matched." "The branch is unmerged." "CI passed."
2. **Name the instrument** that produced it, and ask the only question that matters:
   **could this have exited 0 without measuring anything?** If yes, it is in the catalogue or
   its shape is.
3. **Cross-check with a different shape.** One is enough; it must be able to disagree.
4. **If the two disagree, the instrument is wrong until proven otherwise** — not the world.
   In practice the naive instrument is wrong far more often than the surprising finding is real.
5. **State the claim with the instrument named.** "`total_count: 0` on a re-query" beats
   "it's gone".

## The reflex list

Eleven shapes cover most of it. The full set, with measurements and primary sources, is in
[`references/catalogue.md`](references/catalogue.md).

| If you are about to say… | The silent instrument | Cross-check with |
|---|---|---|
| "the command succeeded" | a pipeline without `pipefail` reports only the LAST stage; `local x=$(cmd)` returns `local`'s status, not the command's | `set -o pipefail`; declare and assign on separate lines |
| "the exit code was 0" | `${PIPESTATUS[0]}` lies two different ways: in bash a stale read returns the *intervening* command's status (so it reads as **success**); in zsh the variable does not exist — it is `pipestatus`, **1-indexed** — so the read is always empty | prefer `set -o pipefail`; if you must read it, next line only, and `${pipestatus[1]}` in zsh |
| "nothing matched" | `grep` exit 1 IS the answer, not an error; `find` exits 0 having found nothing; `gh` exits 0 on `[]` | assert a known-present control row also comes back |
| "the list is complete" | REST truncates at 30 (max 100) with **no marker in the body**; a GraphQL connection returns its slice silently | `--paginate`, or `total_count` / `pageInfo.hasNextPage`; treat `length == per_page` as truncated |
| "CI passed" | a run is `success` when its only job **skipped**; `--exit-status` returns 0 for a *pending* run | job-level: assert every required job is literally `success` |
| "the branch is unmerged" | squash/rebase/cherry-pick make every **ancestry** instrument say "not merged" | content: `git cherry`, or `git diff --quiet` on the paths |
| "the tree is clean" | `git diff --quiet` is **blind to untracked files** — and flakes ignore untracked files | `[ -z "$(git status --porcelain)" ]` |
| "the loop checked every item" | in **zsh** an unquoted `$list` is not field-split, so `for f in $list` iterates **once** over one blob and exits 0 | `while IFS= read -r x; do … done < <(…)`; compare the loop's count against an independent count |
| "the field is absent" | a wrong `jq` path is `null`, not an error, and `--jq` passes it through as exit 0 | `jq -e`, or `has("key")` |
| "I declared it, so it is on" | **a declaration is not an effect** — a config list can be parsed, validated, asserted over and never consumed, so the line merges green and does nothing | read the **consumer**: `grep` the key and count what reads it, then query the runtime state it was supposed to change |
| "I re-ran it with the stricter flag" | `nix build --option sandbox true` on an **already-built** derivation returns the cached path — exit 0, 0 bytes on stderr, carrying the result the *unsandboxed* build produced | `--rebuild` (or a fresh derivation name), and `nix config show sandbox` to know which default you are fighting |

## Human gates

None — this skill only reads. It never changes state, so it has no destructive step. The
instruments it recommends are all read-only replacements for read-only commands.

## Pitfalls

- **No linter covers this.** Measured 2026-10-02 with ShellCheck 0.11.0: it catches **0 of 9**
  of the shapes that motivated this skill, and it **refuses zsh outright** (`SC1071`: "only
  supports sh/bash/dash/ksh"). `for f in $files` is not `SC2086` — an unquoted `for` list reads
  as deliberate splitting. `shfmt` and `bashate` are formatters. So "just run the linter" is
  not an answer, and ShellCheck never sees an inline command string anyway.
- **Upstream will not fix the zsh case.** `anthropics/claude-code` issue #74888 names it
  exactly — example scripts assuming bash field splitting, breaking silently under zsh — and
  was **closed as not planned**.
- **Say "field splitting", not "word splitting".** The zsh manual flags the second phrasing as
  wrong: zsh omits **implicit IFS field splitting** on unquoted parameter expansion unless
  `SH_WORD_SPLIT` is set. `${=spec}` forces it per-expansion.
- **A cross-check that shares a blind spot is not a cross-check.** Re-running `wc -l` after
  `wc -l` proves nothing; `grep -c ''` disagrees with it on a file lacking a trailing newline.
- **Do not stretch "Heisenbug"** over this whole class. It honestly fits only the async-race
  entries, where observing later changes the answer.

## References

- `verification-before-completion` (obra/superpowers, MIT) — the gate this sits under.
- [`references/catalogue.md`](references/catalogue.md) — the full catalogue: trap, why it is
  silent, the correct instrument, and whether the entry was measured or taken from a document.
- [`tests/trap-cases.sh`](tests/trap-cases.sh) — the catalogue's shell and git entries as
  **runnable assertions**. Each case proves both halves: the naive instrument returns the wrong
  answer, and the named replacement returns the right one. Run it when a claim here looks
  doubtful, or after any toolchain upgrade — an entry that stops reproducing is an entry to fix.
- [Bash Pitfalls](https://mywiki.wooledge.org/BashPitfalls) · [Bash manual, The Set
  Builtin](https://www.gnu.org/software/bash/manual/html_node/The-Set-Builtin.html) ·
  [zsh Expansion](https://zsh.sourceforge.io/Doc/Release/Expansion.html)
- [Silent failure](https://aipatternbook.com/silent-failure) — the established name for this
  class, and `fail fast and loud` as its counter-discipline.
- [GitHub: troubleshooting required status
  checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/defining-the-mergeability-of-pull-requests/troubleshooting-required-status-checks)
  · [REST pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
