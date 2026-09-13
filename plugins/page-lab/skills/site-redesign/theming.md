# Theming a site you do not own

**Check M12 first.** If the site already ships a dark theme, drive it. Everything below
is what to do when it does not.

## The ladder — stop at the first rung that works

| Rung | Approach | When |
|---|---|---|
| 1 | **Drive the site's own theme** — set its cookie, storage key, or root attribute | M12 found one |
| 2 | **A static sheet of overrides** on tokens the site already declares | The site uses custom properties |
| 3 | **A static sheet declaring a full palette** on a root data attribute | The site hard-codes colours in few places |
| 4 | **A CSSOM remap** — walk the stylesheets, map each colour, re-emit under the same selectors | The site hard-codes colours everywhere **and** its sheets are same-origin |
| 5 | **A computed-style repaint** — read the computed colour of every element and derive a dark equivalent | The sheets are **cross-origin**, or the paint comes from inline styles and site JS |

Rungs 4 and 5 are expensive. Do not start there because they sound thorough.

**Rung 4 is simply unavailable against a cross-origin sheet** — `.cssRules` throws
`SecurityError`, so there are no rules to walk. Check this in the survey (M9), not
when the remap fails.

**Rung 5 is the one that makes a theme uniform**, and it is often *better* than rung 4
rather than a fallback from it: `getComputedStyle` is readable on every element and
already folds in inline styles and anything the site's JS set at runtime — exactly the
paint a selector-based theme keeps missing [F-COMPUTED-STYLE-IS-THE-REMAP]. A static
palette can only darken what someone wrote a selector for, which is how one page comes
out black and the next one stock.

Three rules make rung 5 safe to layer on top of rungs 2-3:

- **Make it idempotent by construction.** Phrase the test as *"is this still too
  light"*, so a surface the static sheet already darkened measures as dark and is
  skipped. Running twice then changes nothing.
- **Do not re-measure a surface YOUR OWN sheet painted.** Idempotence stops the repaint
  fighting *itself*; it does not stop it fighting the sheet. A sheet that painted a light
  accent fill with dark ink, followed by a repaint that darkened the fill — correctly, by
  its own rule — and left the ink, measured **1.21:1** and **2.29:1**, and stayed invisible
  until an element hidden inside a closed drawer became visible
  [F-SHEET-VS-REPAINT-FIGHT]. Either exclude your own painted surfaces, using the same one
  own-UI exclusion list, or **paint none** and let the repaint own every colour.
- **Cap the walk.** A few thousand nodes, so a pathological page cannot hang the tab.
  Measured cost on a real listing: 96 ms, 1445 nodes repainted.

## The palette

One block, declared once, on a root data attribute the script sets. Tokens, not
literals — a redesign that hard-codes colours at each use site cannot be retuned or
verified. A useful token set, sized from a real implementation that replaced 51
scattered literals with 17 tokens:

```
bg  surface  raised  raised-hi  dialog
edge  edge-strong
text  text-dim  placeholder
accent  accent-hi  visited  danger
scrim  control-fill  shadow
```

A constructable sheet adopted via `adoptedStyleSheets` sorts **after** the site's own
document sheets, so it wins ties at equal specificity without `!important`
[F-ADOPTED-SORTS-LAST]. That is ordering, not weight — higher site specificity still
wins, and a running animation still outranks everything [F-ANIMATION-BEATS-IMPORTANT].

**Assert the palette resolved before measuring anything downstream.** CSS comments do not
nest, so a marker written inside the sheet's header comment ends it early and the parser
eats the whole palette block — every `var(--token)` then resolves to `unset`, with no
console error and no exception, presenting as "the theme did not apply"
[F-CSS-COMMENT-NESTING]. After `replaceSync`, read one token back per group with
`getComputedStyle(root).getPropertyValue('--…')` and require it non-empty.

## The remap (rung 4)

Walk `document.styleSheets`, read each rule's colour properties, map them, and emit the
mapped declarations **under the same selectors**. Four things decide whether it works.

### 0. Channel scaling preserves hue — and cannot lift black

Scaling `r`, `g`, `b` by **one** factor is the correct way to change a colour's
lightness while keeping its hue exactly. It has a singularity: **zero times any factor
is still zero**, so black can never be lifted, and the failure ships as unreadable text
rather than as an error — measured at a contrast ratio of **1.22**, black ink on a newly
black ground, while every other colour mapped correctly [F-HUE-SCALE-CANNOT-LIFT-BLACK].

A near-black colour carries **no hue to preserve**, so map it to a neutral at the target
lightness instead. The mirror case exists at white for any mapping that scales downward.

### 1. Neutrality is chroma, not HSL saturation

`chroma = (max(r,g,b) - min(r,g,b)) / 255`, threshold around `0.12`.

HSL saturation is normalised by lightness, so it explodes at the extremes and calls
near-white an accent. A page ground of `rgb(252, 252, 248)` computes HSL saturation
**0.40** — and the cream page came back **olive** [F-CHROMA-NOT-HSL].

### 2. A preserved colour must be RE-DECLARED, not skipped

A broad flatten rule written with `:not(...)` carries its most specific argument's
weight — ID weight if any argument has an ID. So declining to map a colour does not
preserve it; the flatten rule outscores the site's own declaration and the colour is
lost anyway [F-NOT-TAKES-MAX-SPECIFICITY].

### 3. Exclude your own UI, from one list

Maintain **one** exclusion list, interpolated into both the static sheet and every rule
the remap emits. Without it the remap recolours the UI the redesign itself built —
a site `a { color }` rule, re-emitted at ID weight, lands on your own constructed link.

### 4. Cross-origin sheets throw

Reading `.cssRules` on a cross-origin sheet throws. M9 reports which sheets those are;
the remap must skip them and the theme must not depend on what they declare.

## Contrast repair

After the theme is applied, sweep the rendered tree and repair text that still fails.

**Key the repair on the measured contrast ratio alone.** A "the background is light"
gate silently skips mid-tones — a strip at relative luminance `L = 0.35` fell outside
such a branch and went from **2.49 to 1.80**, worse than no theme at all
[F-CONTRAST-RATIO-ONLY].

The shape that works:

- compute the background's relative luminance,
- compute the ratio against **both** inks (a near-black and a near-white),
- apply whichever **measures** better,
- cap the sweep (a few hundred nodes) so a pathological page cannot hang the tab.

Target WCAG AA on body text. **Record the measured ratios** — "contrast is fine" is not
a measurement.

## Motion

One duration scale and one easing curve across the whole redesign. Restraint reads as
design; three different durations read as three different authors.

- **Fading anything that toggles `display` needs BOTH `transition-behavior:
  allow-discrete` AND `@starting-style`.** With only one, the transition is skipped
  **silently** — no warning [F-DISCRETE-NEEDS-BOTH].
- Wrap all of it in `@media (prefers-reduced-motion: no-preference)`.
- Under `reduce`, every faded element must resolve to its **visible** state. A reduced
  motion user seeing `opacity: 0` forever is the worst possible outcome of a fade.

## Media

- **Key an image fade on a marker set in the `load` handler, never on `[src]`.** `src`
  is assigned before a byte decodes, so a `[src]`-keyed fade runs its full duration
  against an empty box and the image still pops in at the end — the exact artefact the
  fade was meant to remove [F-SRC-NOT-LOAD].
- Honour the site's `loading="lazy"`; do not eagerly load a wall of media you just made
  larger.
- Preserve true aspect ratio with `aspect-ratio` — **on the grid ITEM, not on its child**:
  in a content-sized row the child's ratio resolves against an indefinite width and the row
  collapses, which is how a wall of 98 units renders 0 [F-ASPECT-RATIO-IN-AUTO-ROW]. Let
  `object-fit` do the fitting.

## Layout

Intrinsic sizing over breakpoints. One rule that holds from 1280 to 2560 beats a stack of
media queries and cannot fall out of sync with itself:

```css
grid-template-columns: repeat(auto-fill, minmax(clamp(300px, 28.5vw, 510px), 1fr));
```

Verify at all four widths from M11, and assert **no horizontal overflow** on the
document element at any of them.

## Where to read next

- [`SKILL.md`](SKILL.md) · [`survey.md`](survey.md) — M9 and M12 feed this file.
- [`acceptance.md`](acceptance.md) — how the theme gets verified rather than asserted.
