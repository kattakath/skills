# Relocating the site's own controls

The premise: an overlay or drawer that holds the site's real controls, **moved**, not
rebuilt. A rebuilt control diverges from the site the first time the site changes; a
moved one cannot.

## Adopt or relocate — decide per surface, from the DOM

Moving a node is the fallback, not the default. If M13 found the site already collapses
its own chrome, the cheaper build **adopts** that: leave every node where it is, un-gate
the site's own rules, and drive the site's own switch.

| | **Adopt** | **Relocate** |
|---|---|---|
| Nodes move | no | yes |
| Ancestor chain changes | no | yes |
| Matched-style breakage below | **cannot occur** | applies in full |
| Needs | the site ships a compact layout | nothing |

The whole of the next two sections is "what breaks when the ancestor chain changes".
**Adopt mode makes them moot** — which is most of the value.

Two cautions, both measured:

- **Decide the mode structurally, each run, never by URL and never latched.** One site
  served two different shells at the *same* URL across loads, with the mechanism present
  on one and absent on the other (`0` matching nodes).
- **Adopting can invert a removal.** If the drawer lives inside the very chrome you meant
  to delete, deleting it takes the drawer with it. The resolution is usually that the
  container **becomes** the panel rather than being removed — but you must check, because
  it silently contradicts the "remove all chrome" half of the brief.

## Before you move anything

| Check | Source | Failure if skipped |
|---|---|---|
| Is the handler on the node, or **delegated to an ancestor**? | M6 | The control renders perfectly and **does nothing** |
| Which matched rules depend on the ancestor chain? | M7 | It overflows or collapses in its new home |
| Does a dialog it opens depend on **DOM adjacency** for dismissal? | M8 | The dialog opens and cannot be closed by pointer |

**M6 is the one that costs a rewrite.** A delegated handler means the listener lives on
an ancestor and matches by `event.target.closest(...)`. Move the node out of that
ancestor and the event never reaches the listener. Options, in order of preference:

1. Move the **delegation root** instead of the leaf, so the whole subtree travels.
2. Move a container that still sits inside the delegation root.
3. Only if neither is possible: re-dispatch. This is a last resort and it is a
   divergence — record it in the header block with the date and the reason.

## The move itself

- Record **original parent + next sibling** at move time. Teardown puts the node back
  there, not merely back into the document.
- **Assert from the DOM each pass, never latch.** Check `host.contains(node)`, not
  `node.isConnected` — a node the site reclaimed is still connected, just no longer
  yours.
- Mark moved nodes with a data attribute. Every rule that repairs their layout scopes to
  that marker, so a failed move renders **stock** rather than mangled.

## Repairing the layout after a move

Check in this order — the first two have been the real cause more often than the third:

1. **Grid track lists.** An inherited `grid-template-columns: 410px 409px 108px` inside
   a 383 px rail overflows no matter what widths you set. Fix with
   `grid-template-columns: minmax(0, 1fr)` plus `min-width: 0` on the items
   [F-GRID-TRACKS-NOT-WIDTHS].
2. **Margins.** Stock margins summed to 400 px in the same 383 px column — 9 px either
   side of a word plus 17 px before a chevron. `margin-inline: 0` and a `column-gap`.
3. **Widths.** Usually already `auto` or percentage, and usually not the problem.

## The container

**Never `transform` an ancestor of a `position: fixed` control.** A transformed ancestor
becomes the containing block for fixed descendants, so the "fixed" toggle button rides
the panel off-screen [F-TRANSFORM-CONTAINING-BLOCK]. The same applies to `filter`,
`perspective`, `backdrop-filter`, `contain: paint`, and `will-change` on any of them.

Slide off-canvas with a `right` (or `inset-inline-end`) offset instead, or with the
independent `translate` longhand on a node with no fixed descendants.

Respect `env(safe-area-inset-*)` on the fixed controls, and size the panel in `dvh`
rather than `vh` so a mobile URL bar does not clip it.

## Dialogs — the trap

A site that pairs a dialog with its backdrop **by DOM position** will break when you
move the trigger: the backdrop never gets shown, so a pointer click outside hits
nothing, **while Escape keeps working**. That asymmetry reads as "something is trapping
my clicks" and sends debugging entirely the wrong way [F-BACKDROP-ADJACENCY].

Diagnose it in one step: with the dialog open, read `display` on every backdrop-ish
node. All `none` is the answer.

Fix it with the site's **own** element and its **own** handler. If each backdrop
immediately follows its modal, an adjacent-sibling rule shows exactly one scrim — the
correct one — and can never stack two:

```css
[data-redesign] .modal--open + :is(.modal__backdrop, .js-modal-backdrop) {
  display: block !important;
}
```

Adding a dismissal path of your own instead would work and would be wrong: it duplicates
behaviour the site already has, and diverges the moment the site changes it.

## Keeping only a few things on a page

"Only the player and the gallery", "only the article", "only the listing" — the shape is
always the same: a few **keepers**, and everything else gone.

Walk from each keeper up to `body` marking the path, then hide, level by level, every
node that is neither on a path nor inside a keeper. That handles arbitrary nesting
without naming a single container.

**Gate it on finding a keeper.** If no keeper resolves, do *nothing* — hiding by
elimination hides **more** as it matches **less**, so a renamed selector must render the
page stock rather than blank it. This is the same rule as the elimination gate in
`SKILL.md`, and it is the one that stops a redesign shipping an empty page.

**Check what the keeper is nested inside before you remove its container.** A drawer,
a player or a gallery frequently lives inside the very chrome the brief says to delete —
measured on one site, the `<header>` tag sat inside `DIV#header` and *contained* the
adopted drawer, so a blanket rule on either would have deleted the overlay along with
the chrome.

## Accessibility — not optional polish

- `aria-expanded` on the toggle; a real `role` on the panel.
- **Focus trapped while open, focus restored on close.**
- `inert` on the background while open — the IDL property, not a class.
- **Escape closes. Trusted click-outside closes.** Both, verified.
- **Escape must close the TOPMOST thing.** If a site dialog is open over your panel,
  Escape closes the dialog. Assert which is open **from the DOM** — a guard keyed on the
  event target is wrong, because a trigger click leaves focus inside the panel.
- If a fullscreen or theatre state exists, the corner slot swaps toggle for close,
  mutually exclusive — two controls in one corner is a bug, not a feature.

## Where to read next

- [`SKILL.md`](SKILL.md) · [`survey.md`](survey.md) — M6, M7 and M8 feed this file.
- [`acceptance.md`](acceptance.md) — every relocated control gets re-exercised.
