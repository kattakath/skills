# The silent-instrument catalogue

Every entry here meets one bar: **it exits 0, or returns a benign or empty result, while having
measured nothing or the wrong thing.** A loud error is out of scope — an agent cannot be
confidently wrong about a `fatal:`. The danger is the clean-looking answer.

**Evidence markers.** `MEASURED` = reproduced on a real machine (bash 5.3, zsh 5.9, git 2.55,
jq 1.7.1, gh 2.100, Determinate Nix 3.22.5, Darwin 27). `DOC` = primary source quoted. Entries
carrying only `DOC` are marked, and the weakest are flagged at the end. `tests/trap-cases.sh`
turns the shell and git entries into runnable assertions, so a toolchain upgrade that changes one
is caught rather than silently believed. Sections **C** and **D** are documented but not asserted:
C needs a network and an authenticated `gh`, and D needs a Nix daemon plus one specific fleet's
option schema — CI must stay credential-free and portable.

---

## A. Shell — exit status and expansion

### A1 · `local x=$(cmd)` discards the command's status
`local`, `export`, `declare` and `readonly` return **their own** status, always 0, so the
substitution's failure vanishes and `set -e` never fires.
`local x=$(false)` → `$?` **0**, script survives `set -e`; `y=; y=$(false)` → **1**, `set -e`
kills it.
**Correct:** declare and assign on separate lines — `local x; x=$(cmd) || return 1`.
`MEASURED` · `DOC` [SC2155](https://www.shellcheck.net/wiki/SC2155)

### A2 · `set -e` is suspended for the WHOLE function when the call is a condition
Not just the failing command: `-e` is off for everything the function runs. `if f`, `f && …`,
`! f`, `while f` all do it. A function whose first line is `false` continues and returns 0, so
the `if` takes the **true** branch.
**Correct:** return explicitly (`cmd || return 1`); never let `-e` be the check inside a
function you call conditionally.
`MEASURED` · `DOC` [Bash, The Set Builtin](https://www.gnu.org/software/bash/manual/html_node/The-Set-Builtin.html)

### A3 · Command substitution does not inherit `errexit`
`o=$(false; echo AFTER)` under `set -e` → captures `AFTER`, `$?` **0**. With
`shopt -s inherit_errexit` the same line exits 1.
**Correct:** `shopt -s inherit_errexit` (bash ≥ 4.4), or one command per substitution.
`MEASURED` · `DOC` Bash `shopt`: *"command substitution inherits the value of the errexit
option, instead of unsetting it in the subshell environment"* — not on by default.

### A4 · Without `pipefail`, a pipeline reports only its LAST stage
`false | tail -1` → **0**. Every `… | jq .`, `… | sort`, `… | tail` reports the consumer.
**Correct:** `set -o pipefail`, or `${PIPESTATUS[@]}` read immediately (see A5, A6).
`MEASURED` · `DOC` same page: pipefail *"is disabled by default"*.

### A5 · `pipefail` + an early-exiting consumer turns SUCCESS into failure
`producer | grep -q X` — the consumer exits on first match, the producer dies of SIGPIPE
(**141**), and `pipefail` reports 141 for a pipeline that did exactly what was asked. Under
`set -o pipefail`, `if yes hello | grep -q hello` takes the **else** branch.
**Correct:** `grep -q X < <(producer)`, or capture then test, or accept 141 explicitly.
`MEASURED` — the worst entry in the set, because it inverts a true answer.

### A6 · `${PIPESTATUS[0]}` fails in TWO different ways, and neither is what it looks like
This entry was wrong in its first draft, and `tests/trap-cases.sh` is what caught it. The
mechanism is **shell-dependent**:

- **bash** — `PIPESTATUS` is rewritten by the next command, so a stale read returns the
  *intervening* command's status. Measured: `false | true; echo x >/dev/null;
  echo "${PIPESTATUS[0]}"` → **`0`**. Not empty — it reads as **success**, which is worse.
- **zsh** — there is no `PIPESTATUS` at all. The variable is `pipestatus`, and zsh arrays are
  **1-indexed**, so `${PIPESTATUS[0]}` is unconditionally empty — staleness is irrelevant.
  Measured: `${PIPESTATUS[0]}` → `[]`, `${PIPESTATUS[1]}` → `[]`, `${pipestatus[1]}` → `1`.

So the same expression is a wrong-value bug in one shell and a nonexistent-variable bug in the
other, and in neither does it say so.

Separately: `echo "[$(exit 7)]"` → `$?` **0**, because the status is `echo`'s, while bare
`x=$(exit 7)` → 7.
**Correct:** prefer `set -o pipefail` over reading the array at all; if you must read it, do so
on the very next line and use `${pipestatus[1]}` in zsh. Assign, test, then print.
`MEASURED` in both shells — and note no ShellCheck code exists for the stale read.

### A7 · Command substitution strips ALL trailing newlines
A 6-byte file (`a\nb\n\n\n`) captured through `$(cat f)` is **3 bytes**. Byte-exact comparisons
and hash checks done through a capture compare a different string than the file holds.
**Correct:** compare files, not captures (`cmp`, `git hash-object`); or
`v=$(cat f; printf x); v=${v%x}`.
`MEASURED`

### A8 · `grep` exit 1 is an answer; `grep -c` prints `0` **and** exits 1
`grep nomatch` → empty, status 1 — under `set -e` the script dies on a legitimate "absent".
`n=$(grep -c pat f)` sets `n=0` and returns 1, so `… || die` kills you on a true answer.
**Correct:** `grep -q` for presence; `n=$(grep -c pat f || true)` when the count is the
measurement.
`MEASURED`

### A9 · `diff` exit 1 means "differs" — `if diff …` reads backwards
0 = identical, 1 = different, ≥ 2 = trouble. Testing `!= 0` cannot tell "different" from "real
error".
**Correct:** `cmp -s a b` for identity, or branch on the three bands.
`MEASURED`

### A10 · `find` exits 0 having found nothing, and `-exec cmd \;` does not propagate status
`find d -name absent` → empty, **0**. `find d -name present -exec false {} \;` → **0**.
`-exec … +` differed between BSD and GNU here, so rely on neither.
**Correct:** `find … -print0 | xargs -0 -r cmd` (xargs does propagate), or a `while read -d ''`
loop with `|| exit 1`, or count: `[ "$(find … | wc -l)" -gt 0 ]`.
`MEASURED`

### A11 · `[ -n $VAR ]` unquoted is TRUE for an empty variable
The expansion vanishes, leaving `[ -n ]`, which `test` reads as one non-empty argument → true.
`[ -z $E ]` is *also* true. `[[ -n $E ]]` is correctly false — `[[ ]]` does not split or glob.
**Correct:** quote inside `[ ]`, or use `[[ ]]`.
`MEASURED`

### A12 · Unset and empty are the same to `-z`/`-n`
"The field is missing" and "the field is empty" are different findings; the usual test cannot
separate them.
**Correct:** `${VAR+set}` (empty iff unset), `${VAR-unset}`, or `declare -p VAR`.
`MEASURED`

### A13 · An `ERR` trap does not reach into functions, subshells or substitutions
The safety net you installed is absent exactly where failures hide. A failing command inside a
function that returns 0 fires **no** trap; `set -E` fires it immediately.
**Correct:** `set -E` (errtrace) alongside the trap.
`MEASURED` · `DOC` Bash: *"any trap on ERR is inherited by shell functions… The ERR trap is
normally not inherited in such cases."*

### A14 · A file with no trailing newline loses its last line — to `read` AND to `wc -l`
On a 3-line file ending without `\n`: a `while IFS= read -r` loop counted **2**, `wc -l` said
**2**, `grep -c ''` said **3**. The loop exits 0 having processed n−1 items.
**Correct:** `while IFS= read -r L || [ -n "$L" ]`; count with `grep -c ''`, not `wc -l`.
`MEASURED`

### A15 · zsh arrays are 1-indexed and `[0]` is silently empty
A bash-habit `${arr[0]}` in zsh yields `""` with no diagnostic, so "the first element" becomes
absent downstream.
**Correct:** index from 1 in zsh, or `${arr[@]:0:1}` (0-based in both), or run under `bash`.
`MEASURED`

### A16 · zsh omits implicit IFS field splitting — the loop runs ONCE
This is the entry that cost the most. In zsh an unquoted `$list` is **not** field-split
(`SH_WORD_SPLIT` off by default), so `for f in $files` iterates once over the entire value as a
single word, runs against a nonsense path, and **exits 0**. Related: an unmatched glob in bash
expands to the literal pattern, so the loop also iterates once; in zsh the error is loud at top
level but swallowed inside `$( )`.
**Correct:** `while IFS= read -r x; do …; done < <(producer)` — split-free in both shells. For
`$PATH`, `tr ':' '\n' | while read -r d`. Force splitting per-expansion with `${=spec}`.
**And cross-check the count** against an independent one; the loop's own exit status cannot
tell you it did nothing.
`MEASURED` · `DOC` [zsh Expansion](https://zsh.sourceforge.io/Doc/Release/Expansion.html):
*"Words of unquoted parameters are not automatically split on whitespace unless the option
SH_WORD_SPLIT is set. This is an important difference from other shells."* The manual notes the
option governs **field splitting** and flags "word splitting" as the wrong term.
No linter catches it: ShellCheck refuses zsh (`SC1071`) and does not flag the bash form either.

### A17 · `/bin/sh` may be bash 3.2 in POSIX mode — `echo -e` prints `-e`
Measured on macOS: `/bin/sh -c 'echo -e "a\tb"'` → literal `-e a\tb`, while bash and zsh
interpret it. Whatever parses that output sees a corrupted first field. Also assume no bash-4
features (`inherit_errexit`, `mapfile`, `declare -A`).
**Correct:** `printf '%b\n'`, never `echo -e`.
`MEASURED`

### A18 · `(( expr ))` returns 1 when the result is 0
`(( count ))` with count 0, `(( x = 0 ))`, `(( i++ ))` from 0 all return **1** and abort a
`set -e` script **with no message at all** — the purest form of this class.
**Correct:** `(( expr )) || true`, `: $(( … ))`, or pre-increment `((++i))`.
`MEASURED`

### A19 · `xargs` with empty input runs the command once — on GNU, not BSD
`find … | xargs check` on an empty result runs `check` with no arguments on Linux CI, which many
tools read as "operate on stdin/everything", exit 0. The same script therefore measures
different things on a Mac and in CI.
**Correct:** `xargs -r` / `xargs -0 -r`, or test the input is non-empty first.
`MEASURED` (BSD half) · `DOC` [GNU xargs](https://man7.org/linux/man-pages/man1/xargs.1.html):
`-r` — *"Normally, the command is run once even if there is no input."*
⚠ The GNU half is doc-only.

### A20 · `curl` exits 0 on HTTP 404/500 and hands you the error body
The most dangerous API instrument. `curl -s …/api | jq .field` returns a clean empty answer from
a 404 JSON error page, exit 0 end to end. `curl -sf` on the same URL → **22**.
**Correct:** `curl -fsS`, or capture the code with `-o body -w '%{http_code}'` and branch.
`MEASURED`

### A21 · `ps aux | grep name` always matches itself
The liveness check that can never say "not running": `grep -c` returned **3** for a process that
did not exist, and `grep -q` exited **0**.
**Correct:** `pgrep -x name` (exit 1, no output, for an absent process).
`MEASURED`

---

## B. git

### B1 · `git checkout -- <path>` restores from the INDEX, not from HEAD
The "undo my edit" reflex **preserves a staged mistake** and discards only the unstaged part.
With `STAGED-BAD` staged over a HEAD of `base`, `git checkout -- f` produced **`STAGED-BAD`**.
**Correct:** name the source — `git checkout HEAD -- <path>`, or
`git restore --source=HEAD --staged --worktree <path>`.
`MEASURED` · `DOC` [git-checkout](https://git-scm.com/docs/git-checkout): *"Replace the specified
files… with the version from the index."*

### B2 · `..` and `...` mean opposite things to `diff` and to `log`
`git diff main..feat` includes what **main** changed, so it answers "how do these trees differ",
not "what does the branch add". Measured on a diverged pair: `diff main..feat` → two files,
`diff main...feat` → one. For `log` it inverts — `log main..feat` is the branch's commits,
`log main...feat` is **both** sides.
**Correct:** "what does the branch add" = `git diff main...feat` and `git log main..feat`.
`MEASURED` · `DOC` [git-diff](https://git-scm.com/docs/git-diff): `A...B` *"is equivalent to
git diff $(git merge-base A B) B"*.

### B3 · Empty output + exit 0 from a bogus range or pathspec
A typo'd path and a structurally empty range look identical: `log HEAD..HEAD` → 0,
`log -- no/such/path` → 0, `diff --stat HEAD -- no/such/path` → 0.
**Correct:** prove the path first — `git cat-file -e HEAD:<path>` or
`git ls-files --error-unmatch <path>`; pass `--` explicitly.
`MEASURED`

### B4 · After squash or rebase, ancestry is the wrong test — content is the only test
`merge-base --is-ancestor`, `git branch --merged` and `log target..branch` all answer "is this
commit **object** reachable". Squash, rebase, cherry-pick and `am` produce a new object with the
same content, so every one says "not merged". Measured after `merge --squash`:
`--is-ancestor` → **1**, `branch --merged` → `main` only, yet `git cherry main feat` → `-<sha>`
and `git diff --quiet main feat -- <path>` → **0**.
**Correct:** ancestry is valid only for true merges and fast-forwards. Otherwise
`git cherry <upstream> <branch>` (`-` = already applied), `git log --cherry-mark`, or
`git diff --quiet` on the paths. For a PR, the authority is `gh pr view --json state,mergedAt`.
`MEASURED` · `DOC` [git-cherry](https://git-scm.com/docs/git-cherry): *"prefixed with `-` for
commits that have an equivalent in <upstream>… based on the diff."*

### B5 · `git diff --quiet` is blind to untracked files — and so is `git stash`
With only an untracked file present, `git diff --quiet` → **0** and `git diff --quiet HEAD` →
**0**, while `git status --porcelain` printed `?? newfile`. Most consequential where **flakes
ignore untracked files**: this blindness is exactly what lets an eval pass over a file git
cannot see.
**Correct:** `[ -z "$(git status --porcelain)" ]` for "clean"; `git stash -u`.
`MEASURED`

### B6 · `git grep` sees only tracked files; `git add -A` silently skips ignored ones
`git grep -l MARKER` found nothing (exit 1) in a file plain `grep -rl` found immediately.
`git add -A` with an ignored file present staged the rest with **no diagnostic**, exit 0.
**Correct:** `git grep --untracked` or `grep -r` for presence;
`git status --porcelain --ignored` / `git check-ignore -v <path>` to learn why a file was
skipped.
`MEASURED` · `DOC` [git-grep](https://git-scm.com/docs/git-grep): *"in the **tracked** files in
the work tree"*.

### B7 · Porcelain is the contract — and porcelain still quotes non-ASCII paths
Two layers. The long `git status` format is explicitly unstable and config-sensitive. And
`--porcelain` *without* `-z` escapes per `core.quotePath`, so a literal comparison fails for any
accented filename: `café.txt` appears as `"caf\303\251.txt"`.
**Correct:** `git status --porcelain=v1 -z` and split on NUL.
`MEASURED` · `DOC` [git-status](https://git-scm.com/docs/git-status): porcelain *"will remain
stable across Git versions and regardless of user configuration"*; with `-z` *"pathnames are
printed as is and without any quoting"*.

### B8 · Stale `origin/*` refs, and `--single-branch` where `fetch` can never help
A deleted remote branch resolves locally forever: after deleting it upstream and a plain
`git fetch`, `git rev-parse origin/doomed` still returned a sha, exit **0**. Worse, in a
`--single-branch` clone (what CI gives you) the refspec is narrowed, so `git fetch` will
**never** bring the branch you are asking about.
**Correct:** `git fetch --prune` always; check `git config --get remote.origin.fetch` before
trusting any `origin/*` absence, and fetch the ref by name.
`MEASURED`

### B9 · A shallow clone returns truncated counts with exit 0
`actions/checkout` defaults to depth 1, so every history question in CI is answered from one
commit: `git rev-list --count HEAD` → **1** where the full repo says 6, exit 0, no warning.
(Range and `describe` queries were loud, which is the safer half.)
**Correct:** gate on `git rev-parse --is-shallow-repository` before any history claim; set
`fetch-depth: 0`, or `git fetch --unshallow`.
`MEASURED` · `DOC` [actions/checkout](https://github.com/actions/checkout): *"Only a single
commit is fetched by default"*.

---

## C. GitHub, `gh` and `jq`

### C1 · The combined commit status is a different system from check runs
`GET /commits/{sha}/status` covers only legacy Commit Statuses. Measured on an all-green commit:
`/status` → `{"state":"pending","total_count":0}`, **HTTP 200**, while `/check-runs` →
`{"total_count":8,"success":8}`. In a mixed repo a green legacy status can coexist with a failed
Actions check.
**Correct:** `/commits/{sha}/check-runs`, GraphQL `statusCheckRollup`, or `gh pr checks`. Never
the combined status alone.
`MEASURED` · `DOC` [REST statuses](https://docs.github.com/en/rest/commits/statuses)

### C2 · A conditionally skipped job reports **Success** to required checks
Nothing in the run, the PR or branch protection distinguishes "passed" from "never executed". A
run concludes `success` when its only job `skipped`, because a skipped job does not fail a run.
This is the aggregate-gate failure mode: a `required-checks` job skipped by a failed dependency
*"may not block merging"*.
**Correct:** read the **job** list, not the run —
`gh api repos/O/R/actions/runs/$ID/jobs --jq '.jobs[]|"\(.name)=\(.conclusion)"'` — and assert
every required job is literally `success`. For aggregate gates use `if: always()` plus explicit
`needs.*.result == 'success'`.
`DOC` [troubleshooting required status
checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/defining-the-mergeability-of-pull-requests/troubleshooting-required-status-checks)
⚠ **Weakest entry** — see the flag below.

### C3 · `gh run list --json conclusion` emits `""`, not `null`, while in flight
So every `//` fallback and null check silently fails to fire:
`{"status":"in_progress","conclusion":"","is_null":false}` — `.conclusion // "FELL_BACK"` did
**not** fall back.
**Correct:** branch on `.status == "completed"` first, then read `.conclusion`.
`MEASURED`

### C4 · `gh run view --exit-status` conflates pending with passed
It returns 0 for a run that has not finished; the flag means "non-zero if run **failed**", and
gh's own help example reads *"run pending or passed"*.
**Correct:** assert completion then conclusion, or `gh pr checks` (which has a distinct exit
code **8** for checks pending), or `gh run watch`.
`MEASURED` · `DOC` gh help text

### C5 · REST list endpoints truncate at 30 (max 100) with no marker in the body
A complete-looking JSON array, HTTP 200, nothing inside saying there is more. Measured:
`per_page=100` → exactly 100 items, exit 0, where `--paginate` yielded **750**. The only tell
was the `Link: rel="next"` header.
**Correct:** `gh api --paginate`, or read `Link` (`gh api -i`), or use `total_count`. **Treat
`length == per_page` as "assume truncated".**
`MEASURED` · `DOC` [REST pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)

### C6 · Search caps at 1,000, and `incomplete_results: false` does not mean complete
`total_count` can exceed what you may ever page, and the field that looks like a truncation flag
means *query timeout*: `{"total_count":671,"returned":1,"incomplete_results":false}`.
**Correct:** compare `total_count` against items retrieved; narrow the query above 1,000. Do not
read `incomplete_results` as completeness.
`MEASURED` · `DOC` [Search API](https://docs.github.com/en/rest/search/search): *"Reaching a
timeout does not necessarily mean that search results are incomplete."*

### C7 · A GraphQL connection returns its slice with nothing marking it partial
`first: 100` is the max. Measured: `issues(first:100)` → `totalCount=18554 returned=100
hasNextPage=true`; the same query **without** `pageInfo` selected returns 100 nodes, exit 0, and
no field anywhere says it is one page of 186.
**Correct:** always select `pageInfo { hasNextPage endCursor }` and `totalCount`, and loop.
`MEASURED`

### C8 · `gh api --paginate` on object-shaped endpoints emits one object PER PAGE
Array endpoints merge. Object-wrapped ones (`/actions/runs`, `/search/*`, `/check-runs`) do not,
so a `jq` expression over the wrapper runs once per page: `jq '.total_count'` printed `802`
**nine times**. Captured into a variable that is a multi-line string, it compares false against
any single number; truncated to the first line, it looks plausible.
**Correct:** `gh api --paginate --slurp`, or `jq -s '[.[].workflow_runs]|add'`.
`MEASURED`

### C9 · `mergeable: MERGEABLE` means only "no conflicts"; `UNKNOWN` means "still computing"
Mergeability is computed asynchronously, so a read right after a push or a PR creation returns
`UNKNOWN`/`null` — indistinguishable from a real answer. And even `MERGEABLE` says nothing about
whether the merge is *allowed*: measured on a live PR, `{"mergeable":"MERGEABLE",
"mergeStateStatus":"BLOCKED"}`.
**Correct:** read `mergeStateStatus` (`CLEAN` is the only all-clear) and retry while `UNKNOWN`.
The same async shape applies to any just-created object: a field that a workflow sets is `null`
until that workflow runs, which is not the same as "not set".
`MEASURED` · `DOC` GitHub GraphQL schema: `UNKNOWN` — *"The mergeability of the pull request is
still being calculated."*

### C10 · `gh` exits 0 on an empty list
"No rows match" and "my filter, field or repo was wrong" are the same observation: `[]`, exit 0.
Also measured: `gh pr list` defaults to **30** rows and `gh run list` to **20**, so an
empty-looking answer can be a windowing artifact.
**Correct:** make the query prove itself — assert a known-present control row also returns — and
always pass `--limit` explicitly.
`MEASURED`

### C11 · A wrong `jq` path is `null`, not an error, and `--jq` passes it through as exit 0
A typo'd field, a renamed field and a genuinely-null field are indistinguishable:
`--jq '.stargazerz_count'` → empty line, exit **0**.
**Correct:** `jq -e` (exits 1 on null/false) for scalars; assert the shape with
`has("field") or error("field gone")`.
`MEASURED`

### C12 · jq: absent, null, `[]` and `{}` are four findings that look like two
`jq -r` prints the literal string `null` for both an absent key and a real null, so `"null"`
flows downstream as data. `jq -e` catches null and false but **not** empty containers: `[]` and
`{}` both exit **0**. `// empty` swallows `false` as well as null.
**Correct:** `has("key")` separates absent from null; `length > 0` for containers; `// "DEFAULT"`
only where `false` is not a legal value.
`MEASURED`

---

## D. Nix, and declarations that are never read

### D1 · A list that reads like the enablement list — and nothing reads it
In `kattakath/nix-config`, `local.claudePlugins.marketplaces.<mp>.plugins` reads exactly like
"the plugins that are enabled". It is not. It has exactly two consumers, both in
`modules/shared/claude-plugins.nix`: `idsOf`/`allIds` (`:66`) and a per-name assertion (`:186`).
The settings key is `enabledPlugins = lib.genAttrs alwaysOnIds (_: true)` (`:289`), and
`alwaysOnIds` is `allIds` **filtered to three hardcoded names** (`alwaysOnNames`, `:70`). So
adding any other name is a no-op that evaluates, formats, builds, passes CI and merges.

Nothing reports it, and every surface agrees with you: the PR is green, activation succeeds, the
name is visibly present in the file you edited — complete with the comment you wrote explaining
what it now does — and the plugin is simply absent at runtime. Measured on the live file,
`~/.claude/settings.json` holds **42** `enabledPlugins` ids of which **11 are `false`**, a value
that `genAttrs … (_: true)` cannot emit. So the file is written by the CLI and merely *seeded* by
Nix: "my line is in the `.nix`" says nothing about what the runtime holds. nix-config **#751**
added `empire` this way under a comment asserting it changed how every session starts; nothing
happened, and **#754** reverted it. **#753** added `silent-instruments` the same way, and
`silent-instruments@kattakath` is absent from `enabledPlugins` today.

**Correct:** read the consumer, not the declaration —
`jq '.enabledPlugins | has("<plugin>@<mp>")' ~/.claude/settings.json` (`has`, not a value read:
`false` and absent are different findings, per C12), then confirm in a live session's skill
listing. **The general rule, and the point of this entry: a declaration is not an effect.** When
two lists could plausibly be the authority, do not reason about which one *should* be — `grep`
the key's name and count the places that read it. Nothing about this shape is Nix's: a config key
that is parsed, schema-validated and never consumed behaves identically in a Terraform variable,
a Kubernetes annotation, a `package.json` field, a CI matrix entry or an `.ini` section, and in
every one of them the parser's silence reads as approval.
`MEASURED` 2026-10-02

### D2 · `--option sandbox true` changes nothing on an already-built derivation
Nix's own `nix config show --json sandbox` reports `defaultValue: false` on this platform and
documents *"The default is `true` on Linux and `false` on all other platforms."* So a
network-dependent check is green on macOS and red in Linux CI — and the obvious remedy, re-running
it with the sandbox forced on, is itself the silent instrument: **Nix hands back the cached store
path, so the flag changes nothing.** Measured on aarch64-darwin, Determinate Nix 3.22.5, with one
`runCommand` that curls `http://registry.npmjs.org/` into `$out`:

| Run | Result |
|---|---|
| fresh build, darwin default (`sandbox = false`) | exit 0, `http_code=301` — **network reached** |
| **same drv, `--option sandbox true`, no `--rebuild`** | exit **0**, **the same store path**, `http_code=301`, and **0 bytes on stderr** |
| fresh drv, `--option sandbox true` | exit 1, builder exit code **6**, `http_code=000` — denied |

Row 2 is the entry. The flag was accepted, nothing was built, the answer handed back is the one
the **unsandboxed** build produced, and no diagnostic anywhere says the sandbox was never applied.

`--rebuild` is the fix, and it has two sharp edges of its own — both **loud**, so neither is a
catalogue entry (see the rejected table), but both read as a broken check rather than a misused
flag. On a derivation that was never built: *"some outputs of '…drv' are not valid, so checking is
not possible"*, exit 1. On a built one whose builder *tolerates* losing the network: *"may not be
deterministic: output … differs"*, exit 1 — naming nondeterminism, not the sandbox.

**Correct:** force the sandbox on something that must actually build — `nix build --rebuild
--option sandbox true .#checks.<system>.<name>`, or change the derivation so its name is fresh —
and read `nix config show sandbox` first so you know which default you are fighting. State which
of the two you ran: on darwin a green `nix flake check` is not evidence that anything ran offline.
`MEASURED` 2026-10-02 — all three rows, plus both `--rebuild` errors, on this machine ·
`DOC` Nix `sandbox` option, quoted above. Origin: `kattakath/skills#60`, which measured the darwin
default and the cached no-op; the two `--rebuild` failure modes were measured here.

---

## Rejected for being too loud

Tested and **excluded**, because an agent cannot be confidently wrong about an error:

| Candidate | Why rejected |
|---|---|
| zsh unmatched glob at top level | `no matches found`, exit 1 — loud (the `$( )`-swallowed variant is kept, A16) |
| Shallow clone + `log v1.0..HEAD` / `describe` | `fatal:` — loud (the silent count is kept, B9) |
| GraphQL `first: 101` | `EXCESSIVE_PAGINATION`, gh exits 1 |
| `gh api graphql` on an invalid field | gh exits 1 with the message on stderr |
| `git branch -D` on a branch checked out in a worktree | `error: cannot delete branch…` |
| `[ -n $W ]` with a two-word value | `unary operator expected` |
| Stale index → false "dirty" from `diff-index --quiet` | **did not reproduce** on git 2.55 — dropped rather than asserted |
| `git describe` ignoring lightweight tags | **did not reproduce** cleanly — dropped rather than asserted |
| `nix build --rebuild` on a derivation that was never built | `error: some outputs … are not valid, so checking is not possible`, exit 1 — loud. Kept **inside D2** rather than dropped, because it is the flag you reach for to escape a false green, and its message reads as a broken check rather than a misused flag. Same for `--rebuild`'s *"may not be deterministic"* on a builder that tolerates the network loss |

Two entries were dropped for failing to reproduce rather than for being loud. That is the
correct outcome for a catalogue meant to be trusted: an entry that cannot be demonstrated does
not belong in it.

## Flagged weakest entries

- **C2 (skipped job reports Success)** — the only entry resting on documentation with no
  measurement of the trap itself. Constructing it would mean creating a PR with a required,
  `if:`-skipped job and editing branch protection. GitHub's own wording is hedged (*"may not
  block merging"*), and the boundary between a skip that yields `Success` and one that yields a
  blocking `Pending` almost certainly differs between rulesets and classic branch protection.
- **A19 (xargs on empty input)** — the BSD half is measured, the GNU half is documentation only,
  and the divergence between them is the entire point, so the entry is half-verified by
  construction.
- **D2's Linux half** — every row of D2's table was measured on aarch64-darwin. That `sandbox`
  defaults to **`true`** on Linux, and therefore that the same check goes red in CI, rests on
  Nix's own documented default and on `kattakath/skills#60`; no Linux build was run here. The
  darwin half — which is the silent one, and the whole entry — is fully measured.
