# Theming a site you do not own

**Check M12 first.** If the site already ships a dark theme, drive it. Everything below
is what to do when it does not.

## The ladder — stop at the first rung that works

| Rung | Approach | When |
|---|---|---|
| 1 | **Drive the site's own theme** — set its cookie, storage key, or root attribute | M12 found one |
| 2 | **A static sheet of overrides** on tokens the site already declares | The site uses custom properties |
| 3 | **A static sheet declaring a full palette** on a root data attribute | The site hard-codes colours in few places |
| 4 | **A CSSOM remap** — walk the stylesheets, map each colour, re-emit under the same selectors | The site hard-codes colours everywhere |

Rung 4 is expensive and fragile. Do not start there because it sounds thorough.

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

## The remap (rung 4)

Walk `document.styleSheets`, read each rule's colour properties, map them, and emit the
mapped declarations **under the same selectors**. Four things decide whether it works.

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
- Preserve true aspect ratio with `aspect-ratio`, and let `object-fit` do the fitting.

## Layout

Intrinsic sizing over breakpoints. One rule that holds from 320 to 2560 beats a stack of
media queries and cannot fall out of sync with itself:

```css
grid-template-columns: repeat(auto-fill, minmax(clamp(160px, 22vw, 320px), 1fr));
```

Verify at all four widths from M11, and assert **no horizontal overflow** on the
document element at any of them.

## Where to read next

- [`SKILL.md`](SKILL.md) · [`survey.md`](survey.md) — M9 and M12 feed this file.
- [`acceptance.md`](acceptance.md) — how the theme gets verified rather than asserted.
