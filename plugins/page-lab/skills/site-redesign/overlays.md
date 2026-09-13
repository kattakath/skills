# Card overlays — the title that appears on hover

A wall of pictures needs one piece of text: the thing you cannot recover by
looking at the frame. Everything else — duration, quality, uploader, view count —
is furniture, and on a large-thumbnail wall it competes with the content.

**This pattern is solved. Do not re-derive it.** The recipe below is measured, and
every number in it came from a shipped script.

## Check the shelf — including YOUR OWN shelf

`userscript-author` § 0 tells you to check greasyfork/sleazyfork before authoring.
That is the third-party shelf. **There is a second shelf that gets forgotten: the
other scripts in the same repo.**

- [ ] Before building any card affordance, grep the sibling scripts for the
      mechanism, not the name: `line-clamp`, `column-reverse`, `linear-gradient`,
      `:focus-within`, `aspect-ratio`, `pointer-events`.
- [ ] A hit is a **reference implementation with its measurements attached** —
      those header comments record what was tried and what the numbers were.
      Port the approach and cite it; do not copy blindly and do not restart.

Measured value of doing this: on one site the overlay shipped in a single pass
because a sibling script had already established the clamp count, the gradient
direction, the word-break choice and the pointer-events split.

## The recipe

**Anchor at the bottom, no reserved height.**

```css
.overlay {
  position: absolute; left: 0; right: 0; bottom: 0;   /* NO top, NO min-height */
  padding: 22px 10px 8px;
  opacity: 0;
  background: linear-gradient(to top,
    rgb(0 0 0 / 78%) 0%, rgb(0 0 0 / 55%) 55%, transparent 100%);
}
.card:hover .overlay, .card:focus-within .overlay { opacity: 1; }
```

- **The absence of `min-height` IS the mechanism.** With `bottom: 0` and auto
  height, a one-line title is one line tall and a two-line title pushes its own
  top edge up. A reserved two-line box does the opposite — it hangs a short title
  off a fixed top. **The clamp is a ceiling, not a floor.**
- **Gradient `to top`**, so white text holds over a bright frame.
- **`pointer-events: none` on the overlay**, so the card's link keeps every pixel.
  Re-enable it only on something that is itself a link.

**Clamp at two lines.**

```css
.title {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;   /* NOT word-break: break-all */
  word-break: normal;
  line-height: 1.25;
  text-shadow: 0 1px 3px rgb(0 0 0 / 90%);
}
```

- **Two, not one.** Measured on a real listing: **one truncated line cut 70 of 120
  titles; two clamped lines cut 15.**
- **`overflow-wrap: anywhere`, never `word-break: break-all`** — break-all splits
  words mid-syllable; anywhere breaks only a word that cannot fit on its own line.

**Reveal on hover AND focus.**

A hover-only affordance strands every keyboard user, and `:focus-within` is what covers
them — it is the keyboard path, not the touch path, so it stays even though these scripts
are desktop-only (SKILL.md § Desktop only).

The `@media (hover: none)` branch that pins the overlay open for touch is **not needed**: a
userscript manager runs in a desktop browser, where the pointer always hovers.

## Reading the title

Extraction usually keys on the surface's primary link shape — and **that is where
it breaks on the pages that are not that surface.** Measured 2026-09-13: a reader
keyed on video links returned **0 titles across 80 profile tiles**, because those
tiles link to profiles and carry no video link at all.

Fall back in this order, and read `alt` **before** anything overwrites it:

1. the non-picture link's `title` attribute or text,
2. any link's `title` or text,
3. `img.alt`.

## Verifying it

Assert the property that carries the claim, not a keyword:

- `getComputedStyle().top` returns the **used value in pixels, never `auto`**
  [F-COMPUTED-TOP-IS-USED]. "Anchored at the bottom, growing up" is proved by
  `bottom === "0px"` **and** overlay height < card height — not by `top === "auto"`.
- At rest the overlay reads `opacity: 0`; on hover and on `:focus-within` it reads `1`.
- Count the furniture you removed: assert **zero** badge/sub/meta nodes, so a
  regression that reintroduces them fails loudly.

## Where to read next

- [`SKILL.md`](SKILL.md) · [`theming.md`](theming.md) — motion and media rules.
- [`acceptance.md`](acceptance.md) — how these get verified.
- [`../../references/facts.md`](../../references/facts.md) — every `[F-…]` above.
