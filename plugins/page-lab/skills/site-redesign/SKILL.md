---
name: site-redesign
description: >
  This skill should be used when the user wants a whole alternative experience for a
  site rather than one annoyance removed — "dark mode the entire site", "make the
  thumbnails fill the screen and put everything else in a menu", "rebuild this legacy
  app's shell", "redesign <site>", or any userscript that relocates the site's own
  controls, restyles every surface, or is expected to run past a few hundred lines. It
  runs a measure-first survey, builds against a keep-list, and verifies with trusted
  events at document-start before shipping.
---

# Site redesign — survey → design → build → verify → ship

**Use `page-lab:userscript-author` instead when the wish is small.** That skill owns the
single-change loop: hide a banner, fix a broken selector, restyle one element. This skill
starts where that one escalates, and it **reuses** that skill's hard rules rather than
restating them — read them there first.

## Which skill

| Signal | Skill |
|---|---|
| One element, one rule, one annoyance | `userscript-author` |
| A selector rotted and needs re-measuring | `userscript-author` |
| **Every** surface recoloured (a real dark mode) | **this one** |
| The site's **own controls move** to a new container | **this one** |
| A new shell: overlay menu, full-bleed grid, fixed controls | **this one** |
| Work large enough to need a survey before any selector is written | **this one** |

Crossing into this skill does **not** relax anything: the same two gates, the same
metadata bans, the same "anchors are roles and `href`s, never generated classes", the
same "degrade to stock" failure mode.

## Scope first: which surfaces are actually the point

**Ask this before the survey, and make the operator answer it.** A redesign spreads by
default — every page has something wrong with it — and the spread is where the
cost is. Almost all of it buys nothing.

The question is: **which surface is the reason the user opens this site at all?** On a video
site that is the gallery of links into content. Not the watch page, not the category index,
not the profile pages, not the tag listings.

**A page that is not that surface should get NOTHING.** Not a relocated menu, not a tidy-up,
and *not even a theme*. "While we are here, make it dark too" is how a two-rule change
becomes two thousand lines.

**The cheap version of "everything else out of the way":**

- **Autohide the top bar** rather than relocating a menu — it is a handful of rules, it
  strands nothing, and it needs no focus management because nothing is ever removed from
  the accessibility tree.
- **Purge side rails and the footer** on the surfaces in scope. No harvesting needed: on a
  page left alone, every route is still there.
- **Gate on the content surface itself** — "does this page carry the thing I am here for" —
  so every other shape is stock by construction rather than by a list of exceptions.

The evidence for this — what narrowing deleted on two sites, and the trade it buys — is in [`references/keep-list.md`](references/keep-list.md) § Why the list is this short. **Put the trade to the operator rather than assuming either answer.**

## The keep-list — the positive form, and the default

Scope-first says what a redesign does *not* do. The keep-list is the same decision written
forwards, and it is now **the default shape** rather than one site's choice:

> **Keep the content grid. Keep pagination. Autohide the top bar. Remove everything else.**

Read [`keep-list.md`](references/keep-list.md) before designing anything — it carries the whole
pattern: how to qualify a page as *the* surface (three signals, not the word "gallery"),
how to hide the complement by marking paths rather than naming containers, and the two
rules that keep it from shipping a blank page:

- **Gate it.** Hiding by elimination hides **more** as it matches **less**, so a rotted
  keeper test must render the page **stock, not blank**. `keepers.length > 0` is not a gate:
  on one site it passed on **one** organic card and the complement hid **38 of 39**
  [F-ELIMINATION-GATE-ONE-CARD].
- **Check what a keeper is nested INSIDE before removing its container**
  [F-KEEPER-INSIDE-CHROME].

The one thing the list actually builds is the hidden bar — [`topbar.md`](references/topbar.md), a
standard component now, not a per-site invention.

## Desktop only — there is no mobile case

**A userscript manager runs in a desktop browser.** Mobile Chrome has no extension support,
so no reader ever meets one of these scripts at 320px. Verify at **1280 / 1512 / 1920 /
2560** only; 1280 is the floor, not a small case to defend. Drop `@media (hover: none)`,
`env(safe-area-inset-*)`, and any `min(clamp(…), 100%)` wrapper whose only job was stopping
a clamp's floor overflowing a phone — check that it *is* the only job first.

**Do not over-delete.** `repeat(auto-fill, minmax(…))` is what makes one rule serve 1280
through 2560 without a breakpoint stack; `:focus-within` is the KEYBOARD path, not the touch
path; `prefers-reduced-motion` is an accessibility preference, not a viewport. `dvh` stays —
it is not a mobile-only unit and costs nothing.

## Rules and anti-patterns — read before writing code

[`references/rules.md`](references/rules.md) carries the hard rules that go beyond
`userscript-author`'s, the anti-patterns specific to a redesign, and the approaches already
measured and REJECTED so they are not re-proposed. Read it once per redesign, before the
build phase. The four that most often decide a build:

- **Gate every rule that hides by ELIMINATION** — such a rule hides MORE as it matches LESS,
  so scope it to a container the script has marked, and render stock when the gate fails.
- **Never name a script-scope const after a global the script also uses.**
- **Measure the page's own state before painting it**, never through the same repaint.
- **Check the operator's own sibling scripts** before building any affordance.

## Phases

```
Survey (blocking)
  -> Build: theme? | grid | shell (bar + purge)
    -> Integrate (one palette, one lifecycle, one teardown)
      -> Verify (acceptance at document-start, trusted events)
        -> Harden
          -> Ship
```

**Splitting the build across parallel agents is OPTIONAL, and usually not worth it.**
Measured across four sites: one was built by three parallel agents and three were built by
a single agent, and the single-agent builds were the smaller and cleaner ones. The split
costs an integration phase whose whole job is to undo three copies of the palette, the
lifecycle and the teardown. Split only when the survey shows all three lanes are
substantial - and note that a site shipping its own dark theme (M12) empties the theme lane
entirely, which on one site removed the theming half of the script and left 701 lines
against a sibling's 2576.

### 1. Survey — blocking

Run [`survey.md`](references/survey.md) end to end. It is a 13-point template (M1-M13) written to
be re-used verbatim on any site. Its output is a dated table that every later phase
treats as the source of truth.

Three of the thirteen routinely change the whole plan, so read them first when the survey
lands. **Two of them can delete most of a phase before it starts:**

- **M12 — does the site already ship a dark theme?** If it does, drive it. Overpainting
  a stock theme is the reinvented wheel at its most expensive.
- **M13 — does the site already ship a compact layout?** Its mobile view is a shipped
  design for "everything except the content" — the same judgement the redesign has to
  make, already made. Adopting it can make the whole relocation problem moot
  ([`relocation.md`](references/relocation.md) § Adopt or relocate).
- **M6 — are the controls' handlers delegated to an ancestor?** If they are, relocation
  breaks them and the Shell phase needs a different strategy entirely.

### 2. Build — three lanes, not necessarily three agents

| Lane | Owns | Reference |
|---|---|---|
| **Theme** | palette tokens, any CSSOM remap, contrast repair, the own-UI exclusion list | [`theming.md`](references/theming.md) |
| **Grid / Content** | the primary surface: layout, intrinsic sizing, promo elimination, media loading | [`theming.md`](references/theming.md) § Media |
| **Shell** | the autohiding bar, the purge of everything else, and its gate | [`keep-list.md`](references/keep-list.md), [`topbar.md`](references/topbar.md) |

**Check M12 before opening the theme lane at all.** A site that already ships a dark theme
needs no palette, no CSSOM remap and no contrast repair; driving the site's own theme beats
overpainting it on every axis and survives the site's redesigns.

If the lanes are run as separate agents they share two artefacts and must not each invent
their own: **the palette** and **the own-UI exclusion list**. Name both in the survey output
so every lane starts from one copy.

### 3. Integrate

One IIFE, no build step — the file is copied verbatim into extension storage. The
integrator's job is subtractive: one palette, one exclusion list, one duration scale,
one lifecycle object, one teardown. Three agents will have produced three of each.

Escalation is unchanged from `userscript-author` § I: **do not grow a bundler.**

### 4. Verify

[`acceptance.md`](references/acceptance.md) — the groups, the trusted-event discipline, and the
five ways a spec lies.

**Do not write this harness again.** `scripts/redesign-acceptance.mjs` takes a declarative
config and runs the whole group set at **document-start across real navigations**; a new
site is a config file, not a program. The groups follow the keep-list — *the grid applies*,
*everything else is gone*, *the topbar autohides*, *pagination survives and still
navigates*, ***an out-of-scope page is byte-identical to stock***, *N document-start copies
leave one of everything*, *teardown restores* — so a new site's config is the keepers, the
out-of-scope shapes and the thresholds, and nothing else. Start with `--diagnose`, which
prints one line of decision-relevant facts per URL shape and what to look at next.

### 4.5 Harden — before calling it finished

[`hardening.md`](references/hardening.md). Three lanes in parallel — structure, runtime, harness —
sharing no files, each reporting the line ranges it touched.

Not a tidy-up. On the run that produced that file it found a defect whose symptom
**scaled with the number of script copies**, three comments describing features that had
been removed two versions earlier, ~76 lines of unreachable code, and a colour parser
blind to half of CSS's modern serialisations — on a script that had already shipped five
versions and passed 66 acceptance checks.

Two things decide whether the pass is worth running. Hand each lane **the failure
patterns already paid for**, or it rediscovers them at full price. And give it a
**regression net** — the existing suites, required identical or better, not merely green.
A refactor lane without a net is a rewrite.

### 5. Ship

- [ ] Both gates: the repo's lint config **and** `scripts/userscript-meta-lint.sh`.
- [ ] **Bump `@version` first.** A same-version re-install is a silent no-op, and
      Violentmonkey never downgrades.
- [ ] Header WHY block carries the dated measurements — a comment asserting behaviour
      the code does not perform is a defect, not a stale note.
- [ ] Changelog entry with the survey figures and the acceptance counts.
- [ ] **Tell the operator the step only they can do**: re-install, then **reload every
      open tab**. A tab open across a re-install keeps running the old body, and this has
      been mistaken for "the fix did not work" more than once.

## Where to read next

- [`keep-list.md`](references/keep-list.md) — **the default shape**, and how to qualify the surface.
- [`topbar.md`](references/topbar.md) — the autohiding bar, measured. The one thing the list builds.
- [`survey.md`](references/survey.md) — **the blocking phase.** M1-M13, re-usable verbatim.
- [`theming.md`](references/theming.md) — dark mode, the remap, contrast repair, motion, media.
- [`relocation.md`](references/relocation.md) — **the exception**: moving live controls without
  breaking them, for the site that genuinely needs it.
- [`overlays.md`](references/overlays.md) — the hover-title card overlay, measured; and the
  reminder to check the operator's OWN sibling scripts before building any affordance.
- [`hardening.md`](references/hardening.md) — the final pass: three lanes, what each hunts, and
  the rules of engagement with the operator's browser.
- [`acceptance.md`](references/acceptance.md) — verification groups and how specs lie.
- [`../userscript-author/SKILL.md`](../userscript-author/SKILL.md) — the base rules this
  skill assumes.
- [`../../references/facts.md`](../../references/facts.md) — every `[F-…]` cited above.
  **It is ~13,000 words: never read it whole.** Each fact is one table row keyed by its ID,
  so grep for the row instead:

  ```bash
  pl=$(ls -d ~/.claude/plugins/cache/*/page-lab/*/references | tail -1)
  grep -n 'F-INSIDE-THE-GRID-IS-NOT-A-CARD' "$pl/facts.md"   # one fact, by ID
  grep -oE '^\| `F-[A-Z0-9-]+`' "$pl/facts.md"               # list every fact ID
  grep -n 'F-.*PAGER\|F-.*PAGINATION' "$pl/facts.md"         # by topic
  ```

  A citation with no row is a build failure in this plugin's own check, so an unfamiliar
  `[F-…]` always has a row to grep for.
