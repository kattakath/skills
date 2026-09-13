# The keep-list — the default shape of a redesign

**Keep the content grid. Keep pagination. Autohide the top bar. Remove everything else.**

That is not one site's taste; it is the shape two redesigns converged on after both were
built the wide way first and then narrowed. Start here, and widen only against a stated
reason.

## The list

| | Verdict | Why |
|---|---|---|
| The repeating content surface — the grid of units | **KEEP**, restyled full-bleed | it is the reason the page is opened |
| Pagination | **KEEP**, stock, below the surface | without it the wall is one page deep |
| The top bar | **KEEP, hidden** — [`topbar.md`](topbar.md) | search and account still reachable, zero resting pixels |
| Side rails, promo strips, footers, breadcrumbs, category chips, sort widgets, interstitials | **REMOVE** | none of them is why the page was opened |
| Every page that is not the content surface | **UNTOUCHED** — not even a theme (SKILL.md § Scope first) | a page you leave alone strands nothing |

**What the list deletes, compared with a relocating redesign:** the drawer, its focus trap,
its `inert`, its Escape and click-outside handling, the relocation of the site's own
controls, the repair rules that relocation needs, and the harvesting of stranded links.
Nothing is stranded because nothing is moved, and nothing is moved because the bar that
holds it is still there — just hidden.

## Qualifying the page — "gallery" is too loose to gate on

The keep-list is only applied to a page that **is** the surface. Deciding that by a word
("a gallery", "a listing") lets in every page that merely looks like one. The test is
three signals **together**, and the worked form for a video wall is:

> A page qualifies when it carries a **grid** of video **cards** where **(a)** the cards
> **autoplay a preview on hover** and **(b)** clicking a card **goes to a video page**.

Everything else gets **nothing** — no sheet, no attribute, no marker, no theme.

Each signal is doing a job, and dropping any one of them has let a page through:

| Signal | What it rules out |
|---|---|
| **The link target** | the strongest machine-checkable test, so make it the primary one: a card whose anchor resolves to a video route |
| **Hover autoplay** | card markup reused by something that is not a video wall — a channel/profile strip and a photo gallery, on two different sites, both shipped the same card class and neither previews nor links to a video |
| **The grid** | a rail. A related-videos strip beside a player *is* a grid of video cards that previews and links to videos — and is still out of scope |

**The gate is about the PAGE, not only about the cards.** That last row is the subtle one
and it cost a rework: gating on "this page has a qualifying grid" let the watch page in,
because the watch page has one. The rule is **"this page's purpose IS a grid of video
cards"** — the watch page's purpose is the player.

Three practical rules, all paid for:

- **Test the href with `contains`, not a prefix, and verify the shapes.** One kind of card
  came in **two** href shapes on one site; a prefix test missed **29** of them on one shape
  while a contains test matched every one [F-HREF-PREFIX-MISSES].
- **Gate on a SHARE plus a minimum count** — never "at least one card". Measured on one
  site, qualifying shapes scored an organic share of **0.983 to 1.00** and non-qualifying
  shapes scored **0**: a gap that wide is where a floor belongs
  [F-ELIMINATION-GATE-ONE-CARD].
- **Qualify the container that RENDERS.** A page can carry a qualifying grid inside a
  `display: none` parent beside a non-qualifying visible one; `querySelector` happily
  returns the invisible one, and every measurement downstream then describes a box that
  nobody sees.

Whatever the gate is, the **out-of-scope** shapes it has to reject are the ones worth
verifying: put the lookalikes — the watch page, the profile strip, the photo gallery — in
the runner's `stockShapes` and prove they come back byte-identical to a stock load.

## Executing it — mark, then hide the complement

Naming containers does not survive a site's next deploy, and a per-container REMOVE list
grows forever. Do it structurally instead:

1. **Resolve the keepers** from the survey: the surface container, the pager, the bar.
2. **Walk each keeper up to `body`, marking the path.** Every ancestor of a keeper is a
   path node.
3. **Hide, level by level, every node that is neither on a path nor inside a keeper.**
   That handles arbitrary nesting without naming a single container.
4. **Re-enumerate after every removal.** Purging is **layered**: removing three blocks on
   one site *exposed* four more that the first enumeration could not reach, because they had
   been sitting below 1800px of ad frame [F-PURGE-IS-LAYERED]. "Enumerate once, then purge"
   leaves the second layer on the page, and the "everything else is gone" check has to be
   re-run after each change rather than once at the end.

Two things make this safe, and both were learned by shipping without them.

### 1. Gate it — a gate satisfied by ONE match is not a gate

Hiding by elimination hides **more** as it matches **less**. A rotted keeper test therefore
does not fail loudly; it hides the page.

**`keepers.length > 0` is not the gate.** It passes on exactly the run where the test has
rotted off all but one unit: measured on one site, the gate found **one** organic card, ran
the complement, and hid **38 of the 39** units in the container — while the "did the surface
render" check passed, because one card genuinely did [F-ELIMINATION-GATE-ONE-CARD].

- Gate on a **plausible fraction of what the container holds** — the keeper count against
  the container's `children.length` — not on `>= 1`.
- Below that fraction, treat the match as **failed** and render **stock**.
- **Degrading to stock means reverting, not abstaining.** A gate that "does nothing" when a
  keeper is missing leaves whatever the previous pass applied still applied.
- Re-assert it **every pass, from the DOM**. A latched "we found keepers once" flag hides
  the page on the pass after the site changes.

### 2. Check what a keeper is nested INSIDE before removing its container

A keeper routinely lives inside the very chrome the brief says to delete, and the rule
looks correct right up until it runs [F-KEEPER-INSIDE-CHROME].

- On one site `DIV#header` **contained every relocate candidate**.
- On another the hover-preview wrapper sat **after** the still image in flow, not inside
  it — so "keep the card's first child" keeps the still and drops the preview.

Read the ancestor chain **and the sibling order** of every keeper before writing a removal,
and phrase removals against the marked path rather than against a named container. When a
container turns out to hold a keeper, the container **becomes** part of the kept path; it is
not removed and then rebuilt.

## Rules the complement must obey

- **Scope every elimination rule to the marked path**, so a failed mark renders stock
  rather than mangled. `> *:not(:has(X))` unscoped is the blank-page rule.
- **`:has()` matches ANCESTORS.** Count the matches before hiding with it — a content test
  paired with a structural one, and the count confirmed to be what you intend.
- **Hide, do not remove.** Hidden chrome is restorable by teardown and keeps the site's own
  handlers intact; removed chrome is a DOM the site's JS may still be holding references
  into.
- **Nothing is relocated**, so nothing needs a `data-` marker for its original parent, and
  teardown is "stop hiding" rather than "put it back". Relocation still exists as the
  exception — [`relocation.md`](relocation.md).

## Verifying it

These are runner groups, not hand-written probes — see
[`acceptance.md`](acceptance.md) § The groups.

| Claim | Group |
|---|---|
| the grid applies and renders units | `surface` |
| everything else is gone | `purge` |
| the top bar autohides, by pointer and by keyboard | `topbar` |
| pagination survives and still navigates | `pagination` |
| a shape with zero organic units degrades to stock, not blank | `promo-gate` |
| an out-of-scope page is byte-identical to a stock load | `stock-identity` |
| a broken anchor renders stock, not blank | `degradation` |

## The grid's children are not all cards

The keep-list is a list of **containers**, and that is exactly where it leaks. Every
leftover sweep asks *"is this inside a keeper?"* — right for the grid's ancestors, wrong
for its children. A grid container holds whatever the site put in it, and a section
heading or a paragraph of prose laid out as a grid **item** sits among the cards and is
counted as part of the wall by construction.

Measured [F-INSIDE-THE-GRID-IS-NOT-A-CARD]: a block of marketing prose survived **four**
successive sweeps this way, and enumerating non-unit children across shapes turned one
report into a class — prose on one shape, a heading plus a float clearer on another,
**five 79px date headers (395px)** on a third.

Enumerate it directly, per container, and never from the sweep:

```js
[...document.querySelectorAll(GRID)].flatMap(g =>
  [...g.children].filter(k => !k.matches(CARD)))
```

**Gate the rule that hides them.** It hides by elimination, so it hides *more* as it
matches *less*: if the card selector is ever renamed, `> *:not(CARD)` becomes "hide every
child" and the wall goes blank. Put the card test on the **container**, so a rename fails
the gate and the rule stops matching:

```css
[data-wall]:has(> CARD) > *:not(CARD) { display: none !important; }
```

Float clearers go with the rest — a `display: grid` container ignores floats, so keeping
them would mean maintaining a list of which zero-height nodes are safe.

The `purge` group checks this as *every rendered child of the surface is a unit*; declare
any you legitimately keep in `grid.keepChildren`.

## Where to read next

- [`SKILL.md`](SKILL.md) § Scope first — why the list is this short.
- [`topbar.md`](topbar.md) — the hidden bar, measured.
- [`relocation.md`](relocation.md) — the exception: when a control must actually move.
- [`../../references/facts.md`](../../references/facts.md) — every `[F-…]` above.
