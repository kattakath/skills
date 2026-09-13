# The autohiding top bar

The keep-list keeps three things, and this is the one that has to be built
([`keep-list.md`](keep-list.md)). It is a **standard component now**, not a per-site
invention: hidden at rest, revealed when the pointer comes within a few pixels of the top
edge **and** on keyboard focus, **never** scroll-driven.

It replaces the drawer. It strands nothing — the site's own bar is still in the document,
still carrying its own handlers — and it needs no focus trap, no `inert` and no
click-outside handling, because nothing is ever removed from the accessibility tree.

## Why those three rules

| Rule | Because |
|---|---|
| **Hidden at rest** | the wall is the point; a resting bar spends the most valuable band on the screen on furniture |
| **Pointer within a few px of the top edge** | reaching for the top edge *is* the request. Ambiguous elsewhere, unambiguous there |
| **Keyboard focus reveals it too** | a pointer-only reveal strands every keyboard user, and the bar holds search and account |
| **Never scroll-driven** | a scroll-reveal fires on scroll *direction*, which is not intent: it appears while the reader is reading and hides while they hunt. It also needs latched state, which then desynchronises from the DOM |

## The recipe

**Hide with the `translate` longhand, not with `visibility` and not with `transform`.**

```css
[data-redesign-topbar] {
  position: fixed; inset-block-start: 0; inset-inline: 0;
  z-index: 40;                      /* above the wall, below the site's own dialogs */
  translate: 0 -100%;               /* composes; does not compete with a site animation */
  pointer-events: none;             /* a hidden bar must not eat the first row's clicks */
  transition: translate 160ms ease-out;
}
[data-redesign-topbar][data-shown] {
  translate: 0 0;
  pointer-events: auto;
}
@media (prefers-reduced-motion: reduce) { [data-redesign-topbar] { transition: none } }
```

- **`translate`, not `transform`** — a running site animation on `transform` outranks
  author-`!important` and silently pins it [F-ANIMATION-BEATS-IMPORTANT]; the independent
  longhand composes instead of competing.
- **Not `visibility: hidden` / `display: none`** — either takes the whole subtree out of
  the tab order, which kills the keyboard reveal before you write it
  [F-FOCUS-WITHIN-NOT-A-REVEAL].
- **`pointer-events: none` while hidden.** An off-canvas bar still has a box; without this
  it can intercept the top row of the wall. Verify with `elementFromPoint` at the top band:
  it must return a card, not the bar.

**Drive it from the pointer's position, not from the bar's own `:hover`.** A bar that is
off-canvas cannot be hovered, so the trigger has to be document-level:

```js
addEventListener('pointermove', (e) => { show(e.clientY <= BAND); }, { passive: true, signal });
document.addEventListener('pointerleave', () => show(false), { signal });  // pointer left the document
addEventListener('focusin',  (e) => { if (bar.contains(e.target)) show(true); }, { signal });
addEventListener('focusout', (e) => { if (!bar.contains(e.relatedTarget)) show(false); }, { signal });
```

`BAND` is a working range of **4-8 px**: large enough to catch a fast throw at the edge,
small enough that it never fires while the reader is using the first row. Put whichever
number you pick in the acceptance config, so the run tests the number the script uses
rather than a second copy of it.

**Verify the leave path on the live page.** A pointer that exits the window *through* the
top edge is exactly the case that leaves a bar latched open, and which leave event covers it
differs by how the bar is nested. Whichever you pick, assert the bar hides.

**`focusin` on the document, not `:focus-within` on the bar.** `:focus-within` is a
selector, and on one site it revealed nothing while the pointer path worked perfectly — the
keyboard path was dead and no geometry check saw it [F-FOCUS-WITHIN-NOT-A-REVEAL]. If you
do use `:focus-within`, **measure that it fires on the live page**; do not infer it from the
rule.

## The traps

- **Never `transform` (or `filter`, `perspective`, `backdrop-filter`, `contain: paint`,
  `will-change` on those) on an ANCESTOR of anything `position: fixed`.** A transformed
  ancestor becomes the containing block for its fixed descendants, so the bar stops being
  fixed to the viewport and rides its ancestor [F-TRANSFORM-CONTAINING-BLOCK]. This bites
  hardest when the wall itself is given a transform for a motion flourish.
- **A fixed bar frees the band the wall wants — and then OVERLAYS the first row rather
  than pushing it.** That is the whole reason it can be fixed: it is out of flow, so the
  wall keeps the full viewport. The cost lands only while it is revealed, over one row, and
  transiently. **Do not "fix" it by padding the surface while shown** — that reflows the
  entire wall on every reveal, which is far worse than a transient overlap. If the overlap
  is genuinely unacceptable for a first row that must stay legible, scroll-pad with
  `scroll-margin-block-start` on the units instead of moving the wall.
- **Do not put it in the top layer.** `popover` paints over the site's own dialogs, so the
  site's modals become unreachable (SKILL.md § Approaches already measured and rejected).
- **An ADOPTED bar is the site's node, not yours — twice over.** Keeping the site's own bar
  and hiding it is the cheap build, and it has two consequences that both present as "the
  theme missed a surface". Its own rules still apply at their own weight, so a site
  `#header { background: #eee }` **outranks** your `[data-redesign-topbar]` rule on
  specificity — and a constructable sheet sorting last does not rescue you, because that is
  ordering, not weight [F-ADOPTED-SORTS-LAST]. And it is **outside your own-UI exclusion
  list**, so the theme audit counts it as stock paint, correctly. Theme the adopted bar like
  any other site surface.
- **Reveal state is DOM state.** Assert it from the attribute each pass; never latch it in a
  variable that teardown then has to remember to clear.
- **Teardown removes the attribute, the listeners and the sheet** — via the one
  `AbortController` — and the site's own bar is left exactly where it always was.

## Verifying it

The `topbar` group in [`acceptance.md`](acceptance.md) asserts all of it. What it measures,
and why each one is not redundant:

| Assertion | Catches |
|---|---|
| hidden at rest, pointer parked **away from the top edge** | a bar that never hides |
| revealed with the pointer inside the band | a dead pointer path |
| hidden again when the pointer leaves the band | a bar that latches open |
| revealed when focus lands inside it, and `document.activeElement` really is inside | the dead keyboard path [F-FOCUS-WITHIN-NOT-A-REVEAL] |

### Verifying the keyboard route without lying about it

Three ways this check reports a dead keyboard path on a bar whose keyboard path works:

| Mistake | What it looks like | Why |
|---|---|---|
| `el.focus()` with no prior keystroke | "keyboard path is dead" | a correct bar may gate its reveal on the reader having **acted**, because a site that autofocuses a control inside the bar makes `:focus-within` true from load and pins the bar open. That gate opens on a real `keydown` [F-PROGRAMMATIC-FOCUS-IS-NOT-A-KEYBOARD-USER] |
| focusing the **first** match | passes, then fails one shape later | a bar's leading controls are routinely **0x0** icon toggles; `el.focus()` cannot move focus to one [F-ZERO-SIZE-CONTROL-DOES-NOT-TAKE-FOCUS] |
| reading `bar.contains(activeElement)` | a trivial pass | on a site that autofocuses its own search box, focus is *already* inside the bar — the read says nothing about the element you tried |

So: press a **trusted `Tab`** first, walk every match, and require the element to *become*
`document.activeElement`. All three are in the `topbar` group; a config's `focusable` can
stay broad because the walk does the work.

| **still hidden after a scroll**, pointer parked away | a scroll-driven reveal that crept back in |
| no transformed ancestor above a fixed descendant | [F-TRANSFORM-CONTAINING-BLOCK], before it presents as "fixed is not fixed" |

**Park the pointer deliberately.** A harness that parks at `(1, 1)` is parking *inside the
reveal band*, so it reads the revealed state as the rest state. Worse, it breaks a check
that has nothing to do with the bar: the reveal lands **after** the hit-test that set
`:hover`, so `:hover` stays on the card underneath while `elementFromPoint` reports the bar,
and a card-overlay rest read then measures a hover state [F-HOVER-STICKS-UNDER-REVEAL].
Park at the viewport centre for any at-rest read, and choose the element to measure with
`:hover` / `:focus-within` rather than with `elementFromPoint`.

## Where to read next

- [`keep-list.md`](keep-list.md) — the shape this belongs to.
- [`overlays.md`](overlays.md) — the other standard component, the hover title.
- [`acceptance.md`](acceptance.md) — the `topbar` group.
- [`../../references/facts.md`](../../../references/facts.md) — every `[F-…]` above.
