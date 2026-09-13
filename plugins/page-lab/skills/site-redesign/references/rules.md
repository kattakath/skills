# Rules, anti-patterns, and approaches already rejected

Load this alongside [`../SKILL.md`](../SKILL.md) before writing code for a redesign. Every
item here was paid for by a defect that shipped or nearly shipped; none of it is style.

## Hard rules — additional to `userscript-author`'s

0. **Check the shelf, including the operator's own.** Before building any affordance, grep
   the sibling scripts in the same repo for the mechanism — a repo that ships
   several redesigns has usually solved the card overlay, the drawer or the
   lazy-load fade already, with its measurements in the header comment
   ([`overlays.md`](overlays.md)).
1. **Redesign only the surface that is the point**, and qualify that surface by structure
   rather than by a word — [`keep-list.md`](keep-list.md) § Qualifying the page. Everything
   else is stock, including its theme. A rule that exists only because an earlier rule
   widened the scope is a rule neither of them needed.
2. **No selector may be written before the survey is complete.** The survey is a
   blocking phase with its own deliverable ([`survey.md`](survey.md)). "I will measure
   it when I get there" is how a redesign ships a guess.
3. **Prefer hiding to moving — and IF a control must move, move the site's node, never
   rebuild it.** The keep-list moves nothing, which is most of its value. Relocation is the
   exception: a relocated control brings its own handler, a rebuilt one is the reinvented
   wheel and diverges the first time the site changes, and a delegated handler breaks on the
   move [`relocation.md`](relocation.md).
4. **One palette, declared once.** A redesign that hard-codes colours at each use site
   cannot be verified or retuned. Tokens on a root data attribute; the count that
   replaced 51 literals in the reference implementation was 17.
5. **One lifecycle object, one `AbortController`.** Every observer, listener, fetch,
   sheet and saved-state handle lives on it, so teardown is an `abort()` plus a loop —
   not a set of hand-matched removals that drift apart.
6. **Teardown stops new work BEFORE it undoes the DOM**, and every coalescer, builder
   and scan checks a `torn` flag at entry — a queued frame outlives teardown and
   rebuilds what it just removed [F-RAF-SURVIVES-TEARDOWN].
7. **Never name a script-scope const after a global** the script also uses. A const named CSS shadows
   `window.CSS` and `CSS.escape` then throws a TDZ error that reads like something else
   entirely [F-CSS-SHADOWS-GLOBAL].
8. **Geometry proves presence, never function** — the reference plugin's own
   `[F-PRESENT-NOT-WORKING]`. Every primary action is re-exercised under a **trusted**
   event, before and after. A redesign is not verified until the site still works.
9. **Record numbers, not adjectives.** "Contrast is fine" is not a measurement; "4.8:1"
   is. Every claim in the header block and the changelog carries the figure and the date.

## Anti-patterns specific to a redesign

- **Rebuilding a control instead of moving it** (rule 2).
- **Hiding by elimination without a gate** — `> *:not(:has(X))` hides *more* as it
  matches *less*, so a renamed selector mangles the page instead of degrading to stock. A
  gate satisfied by ONE keeper is not a gate [F-ELIMINATION-GATE-ONE-CARD].
- **Removing a container without checking what is nested inside it**
  [F-KEEPER-INSIDE-CHROME].
- **Painting a surface and then re-measuring it through the same repaint** — the two are each
  right by their own rule and the pair is unreadable [F-SHEET-VS-REPAINT-FIGHT].
- **Assuming `:focus-within` reveals a hidden bar.** Measure it; on one site the pointer
  path worked and the keyboard path was dead [F-FOCUS-WITHIN-NOT-A-REVEAL].
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
