---
name: site-redesign
description: >
  This skill should be used when the user wants a whole alternative experience for a
  site rather than one annoyance removed — "dark mode the entire site", "make the
  thumbnails fill the screen and put everything else in a menu", "rebuild this legacy
  app's shell", "redesign <site>", or any userscript that relocates the site's own
  controls, restyles every surface, or is expected to run past a few hundred lines. It
  runs a measure-first survey, splits the build across parallel agents, and verifies
  with trusted events before shipping.
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
| Work large enough to split across parallel agents | **this one** |

Crossing into this skill does **not** relax anything: the same two gates, the same
metadata bans, the same "anchors are roles and `href`s, never generated classes", the
same "degrade to stock" failure mode.

## Scope first: which surfaces are actually the point

**Ask this before the survey, and make the operator answer it.** A redesign spreads by
default — every page you look at has something wrong with it — and the spread is where the
cost is. Almost all of it buys nothing.

The question is: **which surface is the reason the user opens this site at all?** On a video
site that is the gallery of links into content. Not the watch page, not the category index,
not the profile pages, not the tag listings.

**A page that is not that surface should get NOTHING.** Not a relocated menu, not a tidy-up,
and *not even a theme*. "While we are here, make it dark too" is how a two-rule change
becomes two thousand lines.

Measured on two sites that were built the wide way first and then narrowed:

| Built for every shape | Narrowed to the gallery |
|---|---|
| a drawer, with focus trap, `inert`, Escape and click-outside | **deleted** |
| relocation of the site's own controls, and its repair rules | **deleted** |
| harvesting stranded links so nothing lost its only route | **deleted** — nothing is hidden, so nothing is stranded |
| a keep-only island for the watch page | **deleted** |
| two structural modes, because two shells host chrome differently | **deleted** — no chrome is touched |
| a theme that had to reach every surface uniformly | **one surface** |

Every one of those existed to solve a problem **created by widening the scope**. The drawer
existed because chrome was removed; the harvesting existed because the drawer hid things;
the modes existed because two shells hid them differently. None of it served the wall.

**The cheap version of "everything else out of the way":**

- **Autohide the top bar** rather than relocating a menu — it is a handful of rules, it
  strands nothing, and it needs no focus management because nothing is ever removed from
  the accessibility tree.
- **Purge side rails and the footer** on the surfaces you own. No harvesting needed: on a
  page you leave alone, every route is still there.
- **Gate on the content surface itself** — "does this page carry the thing I am here for" —
  so every other shape is stock by construction rather than by a list of exceptions.

**The trade, stated honestly.** A narrow script leaves the rest of the site looking like the
rest of the site: a reader who clicks through to a watch page gets the stock page, theme and
all. That inconsistency is the price, and on both sites the operator judged it cheap against
the machinery it deletes. Put the choice to them in those terms rather than assuming either
answer.

## Desktop only — there is no mobile case

**A userscript manager runs in a desktop browser.** Mobile Chrome has no extension support
at all, so no reader ever meets one of these scripts at 320px. Every rule and every check
aimed at a phone is effort spent on a case that cannot occur.

- **Verify at desktop widths only.** 1280 is the floor; 1280 / 1512 / 1920 / 2560 is a
  complete matrix. Drop the 320 and 768 arms.
- **Drop `@media (hover: none)`.** A desktop pointer always hovers.
- **Drop `env(safe-area-inset-*)`.** There is no notch.
- **Drop `min(clamp(…), 100%)` wrappers** whose only job was stopping a clamp's floor
  overflowing a phone. Check that *is* their only job first.

**Do not over-delete — three things look responsive and are not:**

| Keep | Because |
|---|---|
| `repeat(auto-fill, minmax(…))` | not a concession to phones — it is what makes ONE rule serve 1280 through 2560 without a breakpoint stack |
| `:focus-within` | the **keyboard** path, not the touch path. A desktop keyboard user needs it |
| `prefers-reduced-motion` | an accessibility preference, not a viewport |

`dvh` also stays: it is not a mobile-only unit and it costs nothing.

## Hard rules — additional to `userscript-author`'s

0. **Check the shelf, including your own.** Before building any affordance, grep
   the sibling scripts in the same repo for the mechanism — a repo that ships
   several redesigns has usually solved the card overlay, the drawer or the
   lazy-load fade already, with its measurements in the header comment
   ([`overlays.md`](overlays.md)).
1. **Redesign only the surface that is the point.** Everything else is stock, including
   its theme. A rule that exists only because an earlier rule widened the scope is a rule
   neither of them needed.
2. **No selector may be written before the survey is complete.** The survey is a
   blocking phase with its own deliverable ([`survey.md`](survey.md)). "I will measure
   it when I get there" is how a redesign ships a guess.
3. **Move the site's node; never rebuild its control.** A relocated control brings its
   own handler. A rebuilt one is the reinvented wheel, and it silently diverges the
   first time the site changes. Confirm the handler is on the node and not delegated to
   an ancestor before you move it — [`relocation.md`](relocation.md).
4. **One palette, declared once.** A redesign that hard-codes colours at each use site
   cannot be verified or retuned. Tokens on a root data attribute; the count that
   replaced 51 literals in the reference implementation was 17.
5. **One lifecycle object, one `AbortController`.** Every observer, listener, fetch,
   sheet and saved-state handle lives on it, so teardown is an `abort()` plus a loop —
   not a set of hand-matched removals that drift apart.
6. **Teardown stops new work BEFORE it undoes the DOM**, and every coalescer, builder
   and scan checks a `torn` flag at entry — a queued frame outlives teardown and
   rebuilds what it just removed [F-RAF-SURVIVES-TEARDOWN].
7. **Never name a script-scope const after a global** you also use. `const CSS` shadows
   `window.CSS` and `CSS.escape` then throws a TDZ error that reads like something else
   entirely [F-CSS-SHADOWS-GLOBAL].
8. **Geometry proves presence, never function** — the reference plugin's own
   `[F-PRESENT-NOT-WORKING]`. Every primary action is re-exercised under a **trusted**
   event, before and after. A redesign is not verified until the site still works.
9. **Record numbers, not adjectives.** "Contrast is fine" is not a measurement; "4.8:1"
   is. Every claim in the header block and the changelog carries the figure and the date.

## Phases

```
Survey (blocking, one agent)
  -> Theme | Grid/Content | Shell  (parallel)
    -> Integrator (merge, DRY, gates)
      -> Harness (acceptance, responsive, degradation)
        -> Hardening  (structure | runtime | harness, in parallel)
          -> Ship
```

### 1. Survey — blocking

Run [`survey.md`](survey.md) end to end. It is a 13-point template (M1-M13) written to
be re-used verbatim on any site. Its output is a dated table that every later phase
treats as the source of truth.

Three of the thirteen routinely change the whole plan, so read them first when the survey
lands. **Two of them can delete most of a phase before it starts:**

- **M12 — does the site already ship a dark theme?** If it does, drive it. Overpainting
  a stock theme is the reinvented wheel at its most expensive.
- **M13 — does the site already ship a compact layout?** Its mobile view is a shipped
  design for "everything except the content" — the same judgement the redesign has to
  make, already made. Adopting it can make the whole relocation problem moot
  ([`relocation.md`](relocation.md) § Adopt or relocate).
- **M6 — are the controls' handlers delegated to an ancestor?** If they are, relocation
  breaks them and the Shell phase needs a different strategy entirely.

### 2. Design, in parallel

| Agent | Owns | Reference |
|---|---|---|
| **Theme** | palette tokens, any CSSOM remap, contrast repair, the own-UI exclusion list | [`theming.md`](theming.md) |
| **Grid / Content** | the primary surface: layout, intrinsic sizing, promo elimination, media loading | [`theming.md`](theming.md) § Media |
| **Shell** | overlay, fixed controls, relocation, focus management, dialog dismissal, motion | [`relocation.md`](relocation.md) |

They share two artefacts and must not each invent their own: **the palette** and **the
own-UI exclusion list**. Name both in the survey output so all three start from one copy.

### 3. Integrate

One IIFE, no build step — the file is copied verbatim into extension storage. The
integrator's job is subtractive: one palette, one exclusion list, one duration scale,
one lifecycle object, one teardown. Three agents will have produced three of each.

Escalation is unchanged from `userscript-author` § I: **do not grow a bundler.**

### 4. Verify

[`acceptance.md`](acceptance.md) — the groups, the trusted-event discipline, and the
four ways a spec lies to you.

**Do not write this harness again.** `scripts/redesign-acceptance.mjs` takes a declarative
config and runs the whole group set at **document-start across real navigations**; a new
site is a config file, not a program. Start with `--diagnose`, which prints one line of
decision-relevant facts per URL shape and what to look at next.

### 4.5 Harden — before you call it finished

[`hardening.md`](hardening.md). Three lanes in parallel — structure, runtime, harness —
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

## Anti-patterns specific to a redesign

- **Rebuilding a control instead of moving it** (rule 2).
- **Hiding by elimination without a gate** — `> *:not(:has(X))` hides *more* as it
  matches *less*, so a renamed selector mangles the page instead of degrading to stock.
- **Deciding neutrality on HSL saturation** — it misclassifies near-white and near-black
  [F-CHROMA-NOT-HSL].
- **Skipping a colour to preserve it** — `:not()` carries its most specific argument's
  weight, so a preserved colour must be re-declared [F-NOT-TAKES-MAX-SPECIFICITY].
- **`transform` for off-canvas** — it re-anchors every fixed descendant
  [F-TRANSFORM-CONTAINING-BLOCK].
- **A fixed sleep in a spec** [F-TRANSITION-RACE], and **anything measured in a
  background tab** [F-IO-BACKGROUND-TAB], [F-BG-TAB-FREEZES-ANIM] — the fix is a live
  clock via `Emulation.setFocusEmulationEnabled`, not stealing the operator's window with
  `Target.activateTarget` [F-FOCUS-EMULATION].
- **Verifying by `eval` into a loaded page** [F-INJECT-IS-NOT-INSTALL]. Run
  `scripts/redesign-acceptance.mjs`, which injects at document-start across real
  navigations, rather than writing that harness again.
- **Trusting a null result before asserting the rig** [F-INPUT-SILENTLY-DROPPED] — a dead
  target makes every working control look broken.
- **Treating a site class as a lever without checking its rule is in scope**
  [F-MEDIA-GATED-CLASS-INERT].

## Approaches already measured and rejected

Do not re-litigate these without a new measurement that contradicts the recorded one.

| Rejected | Why |
|---|---|
| `popover` / top layer for our own panel | Paints **over** the site's own dialogs, so the site's modals become unreachable |
| `@layer` for our sheet | Unlayered author styles beat every layer, so the site wins by default |
| `:where()` to keep weight low | Contributes zero specificity — the site's own rules then win ties we need |
| `transform` for off-canvas | [F-TRANSFORM-CONTAINING-BLOCK] |
| `contrast-color()` | Not shippable across the target browsers yet |
| Scroll-snap replacing explicit stepping | Fights the pointer on a long strip |

## Where to read next

- [`survey.md`](survey.md) — **the blocking phase.** M1-M12, re-usable verbatim.
- [`theming.md`](theming.md) — dark mode, the remap, contrast repair, motion, media.
- [`relocation.md`](relocation.md) — moving live controls without breaking them.
- [`overlays.md`](overlays.md) — the hover-title card overlay, measured; and the
  reminder to check your OWN sibling scripts before building any affordance.
- [`hardening.md`](hardening.md) — the final pass: three lanes, what each hunts, and
  the rules of engagement with the operator's browser.
- [`acceptance.md`](acceptance.md) — verification groups and how specs lie.
- [`../userscript-author/SKILL.md`](../userscript-author/SKILL.md) — the base rules this
  skill assumes.
- [`../../references/facts.md`](../../references/facts.md) — every `[F-…]` cited above.
