# The hardening pass

**Run this once the redesign works, and before you call it finished.** It is not a
tidy-up. On the run that produced this file it found a live **defect that scaled with
the number of script copies**, three comments describing features that no longer
existed, ~76 lines of unreachable code, and a colour parser blind to half of CSS's
modern serialisations — on a script that had already shipped five versions and passed
66 acceptance checks.

## Why a separate pass

The phases before this one optimise for *making it work*. Each has a narrow brief and
ships the moment its own checks are green. Three things are therefore invisible to all
of them:

- **What the previous phases left behind** — a helper nobody calls any more, a comment
  that was true two versions ago, a code path both branches now bypass.
- **What no single phase owns** — lifecycle across the whole script, behaviour under
  re-entry, whether the thing degrades to stock when an anchor rots.
- **What only shows up in combination** — two copies, two shells, two modes.

## Three lanes, run in parallel

They must not share files. Give each a lane and require each to **report the exact line
ranges it touched** so the integrator can reconcile.

| Lane | Owns | Explicitly does NOT |
|---|---|---|
| **Structure** | redundancy, dead code, ambiguity, modularity, CSS bloat | change behaviour |
| **Runtime** | lifecycle, teardown, degradation, responsiveness, a11y, error paths | restructure for elegance |
| **Harness** | generalising the specs so the next site is cheaper | touch the script at all |

**The brief matters more than the lane.** Hand each one the failure patterns already
paid for — otherwise they rediscover them at full price. At minimum:
[F-INJECT-IS-NOT-INSTALL], [F-BG-TAB-FREEZES-ANIM], [F-PRESENT-NOT-WORKING], and the
spec-lies list in [`acceptance.md`](acceptance.md).

**Give them a regression net, not just a goal.** Point every lane at the existing
suites and require the results to be *identical or better* after their changes. A
refactor lane without a net is a rewrite.

## Structure lane — what actually pays

Ordered by what this pass found, most valuable first:

- [ ] **Readers that return fields nobody consumes.** One returned seven fields of which
      six had no reader, and paid for a regex pass over every card's text to build them.
- [ ] **Comments that assert behaviour the code does not perform.** This is a **defect**
      in this repo, not a nit. Three were found, all describing features removed in
      earlier versions — a "two tiers, badges, uploader chip" block for an overlay that
      had shipped as title-only two versions before.
- [ ] **Rules that cannot match.** A selector for a slot that no longer exists; a class
      in an exclusion list that nothing ever sets; a removal already subsumed by a
      broader rule below it.
- [ ] **Hand-rolled where a platform primitive exists** — `toggleAttribute` for a
      set/remove pair, `Array.from` for an ES5 array-ify, `replaceChildren`. Check
      `getPropertyValue`/`setProperty` name casing before writing a camel-to-kebab
      converter; they take dashed names verbatim.
- [ ] **Literals repeated across rules that must agree.** A drawer width written four
      times across two modes desynchronises the moment one is edited.
- [ ] **Duplicate selector blocks separated by distance** — two rule sets for the same
      selector 80 lines apart, the later one's declarations dead under the earlier's
      `!important`.

**Require a reason for every refusal, too.** The most valuable output of this lane on
one run was four proposals it *declined*: `:is()` to collapse a selector group would
have **raised** specificity on two of three members, and an `AbortSignal.timeout` swap
would have aborted the very callback the timeout exists to fire.

## Runtime lane — where the real defects were

- [ ] **Re-entry, at three copies not two.** If a bug's symptom is linear in copy count,
      a two-copy test looks exactly like the bug. Inject three times and assert **one**
      of every control, sheet and marker. Assert too that a re-run is **not a silent
      no-op** — it must still apply.
- [ ] **Bootstrap listeners.** A teardown that starts `const life = L; if (!life) return`
      cannot cancel work belonging to a copy that has not started yet. Abort a
      module-scope bootstrap controller **first**, before that return.
- [ ] **Gates that decline rather than undo.** A keeper gate that "does nothing" when a
      keeper is missing leaves whatever the last pass applied. Degrading to stock means
      **reverting**, not abstaining.
- [ ] **Stale markers between passes.** An item marked once and re-classified later stays
      marked unless each pass clears what it no longer owns.
- [ ] **Parsers against modern serialisations.** A colour regex written for
      `rgb(r, g, b)` silently skips `color(srgb …)`, `oklch()` and space-separated
      `rgb(0 0 0 / 50%)` — and a theme built on it is non-uniform for reasons no
      selector explains.
- [ ] **Degradation, anchor by anchor.** Break each one and assert **stock, not blank**.

## Harness lane

Generalise the specs into something the next site configures rather than rewrites, and
make the correct thing the easy thing — see [`acceptance.md`](acceptance.md) § the
runner. Two rules learned the expensive way: a check that cannot be configured must
**skip loudly**, naming the missing config path, rather than pass silently; and the
runner should be exercised against a **purpose-built fixture** whose defects you chose,
because a runner that has never failed has never been tested.

## Rules of engagement with the operator's browser

The operator's browser holds their tabs, sessions and logins. This project killed it
**three times, by three different mechanisms**, before these rules existed.

- **Never `Target.createBrowserContext` / `disposeBrowserContext`.** Disposing takes the
  last window with it and the browser exits.
- **Never close the last page target** — it quits the browser and takes the debugging
  port with it [F-LAST-TAB-KILLS-BROWSER]. Park on `about:blank` instead.
- **Never `Target.activateTarget`.** `Emulation.setFocusEmulationEnabled` gives a
  background tab a real clock without stealing the window [F-FOCUS-EMULATION].
- **Default to refusal, not to the default port.** A harness that defaults to the
  operator's browser will eventually drive it, because a spec only has to *forget*.
  Require an explicit test-browser URL and exit with instructions otherwise. This is the
  only one of these rules that does not depend on anyone remembering.
- **Prefer a throwaway profile**, and close it when the work ends — a debugging port is
  unauthenticated and any local process can drive it.

## Done when

- [ ] All three lanes report, each naming the line ranges it touched.
- [ ] The pre-existing suites are **identical or better**, not merely green.
- [ ] Every lane's refusals are recorded with a reason.
- [ ] Anything unverified is marked **UNVERIFIED**, never assumed.
- [ ] New facts are in [`../../references/facts.md`](../../references/facts.md) with a
      date and a re-measure recipe.

## Where to read next

- [`SKILL.md`](SKILL.md) — the phases this closes.
- [`acceptance.md`](acceptance.md) — the runner, and the ways a spec lies.
