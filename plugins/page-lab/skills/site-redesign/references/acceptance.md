# Verifying a redesign

**Geometry proves a control is present. It never proves it works** [F-PRESENT-NOT-WORKING].
A redesign is verified when every primary action still works under a **trusted** event —
`Input.dispatchMouseEvent` and `Input.dispatchKeyEvent`, never `el.click()`.

## Verify at document-start, or verify nothing

**An `eval` of the IIFE into a loaded page tests a world the installed script never
sees** [F-INJECT-IS-NOT-INSTALL]. The real script runs at `@run-at document-start`:
no `<body>`, no site JS yet, and **the site's own scripts run after it** and may
overwrite what it did. Evaluating at `readyState: "complete"` inverts that order.

This is not a theoretical gap. A suite of **88 injected checks reported 0 failures**
on a build that, once installed, themed only four of six page shapes, rendered one
gallery completely blank, and opened a drawer laid out 55px wide by 5132px tall.
**Six probes at document-start found all five defects in minutes.**

- Inject with **`lab.addDocStart(body)`** — NOT a raw
  `Page.addScriptToEvaluateOnNewDocument`. **CDP injects EARLIER than a userscript
  manager's `document-start`**, early enough that `document.documentElement` is still
  `null` [F-DOCSTART-NO-DOCUMENTELEMENT]; a script whose first act is to check for it
  returns, and **the page then reports stock**. `addDocStart` wraps the body for exactly
  this, and the wrap is skipped by passing the body as an `openLab` option instead.

  This is the most expensive mistake in this file's history, because it does not look
  like a failure. It produced two confident reports that a feature "works identically
  stock and scripted" — when in truth **neither arm had the script**, so stock was being
  compared to stock. A suite that injects this way passes everything and proves nothing.
  If a whole redesign appears not to apply, suspect this **before** the script.
- **Drive real navigations**, one per URL shape — not one `eval` into a settled page.
- Remember the operator's genuinely installed copy is running too. Two copies in one
  document produce **doubled UI counts that look like a teardown bug and are not**;
  tear the previous copy down via its registered global before measuring, and prove
  single-copy behaviour separately.

The repo rule states it in four words: **injecting is not installing.**

Two details that make a document-start probe lie if you skip them:

- The registration **does not run in the page already open** — only on the next
  navigation [F-DOCSTART-NEXT-NAV]. Register, *then* navigate.
- CDP's document-start is **earlier than a manager's**: `document.documentElement` is
  still `null` [F-DOCSTART-NO-DOCUMENTELEMENT]. Wrap the body so it waits for `<html>`,
  or a script that works on install throws under the probe.

Build the suite on the plugin's own scripts, not a second CDP driver: the harness already
carries the node-without-`WebSocket` re-exec [F-NODE-NO-WS], trusted input, `settle()`,
the document-start wrapper and the live-clock fix.

## Running it

Two entrypoints, and the second is not a bigger version of the first:

| Scale | Run |
|---|---|
| One change, one page, already loaded | `scripts/userscript-acceptance.mjs <spec.mjs>` — a `.mjs` spec of hand-written assertions |
| A whole redesign, many URL shapes, document-start | `scripts/redesign-acceptance.mjs <config.mjs>` — a **declarative config**; the groups below come for free |

```bash
pl=$(ls -d ~/.claude/plugins/cache/*/page-lab/*/scripts | tail -1)

# START HERE when something is wrong: facts per URL shape, no verdicts.
node "$pl/redesign-acceptance.mjs" --diagnose ./my-site.redesign.mjs

# The baseline every comparison needs — the same probe with nothing injected.
node "$pl/redesign-acceptance.mjs" --diagnose --stock ./my-site.redesign.mjs

# The suite. --groups and --shape narrow it while you are iterating.
export PL_BROWSER_URL=http://127.0.0.1:9333   # a THROWAWAY browser, never the operator's
node "$pl/redesign-acceptance.mjs" ./my-site.redesign.mjs
node "$pl/redesign-acceptance.mjs" --groups purge,topbar --shape home ./my-site.redesign.mjs
```

**The browser is a required argument, and there is no default.** Pass `--browser-url`, or
set `PL_BROWSER_URL`; with neither, the runner refuses. That is deliberate. The
conventional `:9222` is usually the **operator's own** browser — their tabs, their
extensions, and a userscript manager holding an **installed** copy of the very script under
test. A run that landed there navigated four shapes in the operator's window and returned
**eight confident failures**, every one of them the difference between the installed build
and the file on disk [F-RAN-AGAINST-THE-OPERATORS-BROWSER].

So give verification its own throwaway profile on its own port —
`scripts/route-up.sh --tier 1 --yes --isolated` — and pass that port. A throwaway profile
has no userscript manager, which is the point twice over: no stale installed build to
measure instead of yours, and no second copy to double the control counts. The runner
preflights this anyway, with one un-injected navigation asserting the root flag is absent,
and stops rather than reporting someone else's build as your defects.

The runner opens its tab in the **background** and never brings a window forward, so it can
share a browser safely once you have pointed it at the right one.

A new site is a **config file**, not a new program — copy
[`../../scripts/redesign.config.example.mjs`](../../../scripts/redesign.config.example.mjs),
which is the **keep-list** shape written out in full. What a new site actually fills in is
short: the three keepers (`grid`, `pagination`, `topbar`), the out-of-scope shapes
(`stockShapes`, one line), the purge thresholds, the own-UI prefix, the teardown global,
the desktop widths, and which groups to run. The drawer block and the relocated-control
action list that earlier versions carried are **gone with the machinery they verified**
([`keep-list.md`](keep-list.md)).

`--diagnose` is the mode that matters when you are lost. One line per shape — mode, theme,
grid, visible-vs-total units, overflow, control counts, error count — then the **next thing
to look at** under each shape that is off:

```
shape       mode     theme  grid  units  stray  ovf  controls   err
----------  -------  -----  ----  -----  -----  ---  ---------  ---
home        applied  yes    on    10/12  0      0    topbar:1   0
search      applied  yes    on    16/18  3      0    topbar:1   0
promo-only  blank    yes    -     0/1    0      0    topbar:1   0

search:
  → 3 rendered block(s) are neither a keeper, a path to one, nor ours
promo-only:
  → grid has children and none render: the hide-by-elimination gate matched everything —
    this is the blank-gallery defect, not a styling problem
```

`stray` is the count of blocks that still render **outside the keep-list** — the number
that answers "is everything else gone", and the one that moves when a purge was enumerated
once instead of re-run after each removal [F-PURGE-IS-LAYERED].

**A group whose config is absent SKIPS and says so.** It never fails and never silently
passes — a suite scoring 30/30 because six groups quietly did nothing is the same lie as a
suite that measured the wrong world.

## The groups

The names in the first column are the runner's `--groups` values, so this table and
`scripts/lib/redesign-checks.mjs` cannot drift apart.

| Group | Must prove |
|---|---|
| `rig` | A trusted click on a **plain stock control** has its effect — before any null result is believed. Runs first because it invalidates the rest rather than competing with it. |
| `surface` | **The grid applies**: present, units visible, our attribute landed on it, one aspect ratio. The single most valuable check. |
| `fullbleed` | Fills the viewport and shows **no horizontal overflow**, at every configured **desktop** width. |
| `purge` | **Everything else is gone** — counted as blocks that still *render* outside the keep-list, not checked off a list of selectors [F-PURGE-IS-LAYERED] — **and the gate held**: a keeper fraction of the container, never `>= 1` [F-ELIMINATION-GATE-ONE-CARD]. |
| `promo-gate` | On a shape with **zero organic units**, the elimination gate degrades to **stock, never blank**. |
| `theme` | A measured contrast ratio for **every** text-on-background pair, each at or above target. No stock light background left behind. |
| `controls` | **Exactly one** of each own-UI control. The double-copy detector. |
| `cards` | Unit geometry, banned unit chrome gone, and the overlay asserted on the property that carries the claim — never on a keyword computed style cannot return [F-COMPUTED-TOP-IS-USED]. |
| `topbar` | **The bar autohides**: hidden at rest, does not eat clicks while hidden, revealed by the pointer inside the band, hidden again when it leaves, revealed by **keyboard focus** [F-FOCUS-WITHIN-NOT-A-REVEAL], **not** revealed by scrolling, and no transformed ancestor above a fixed bar [F-TRANSFORM-CONTAINING-BLOCK]. |
| `pagination` | **Pagination survives** the purge where the config says a shape has one, at most one pager renders, it sits after the surface outside our UI, and its "next" **still navigates under a trusted click** [F-PRESENT-NOT-WORKING]. |
| `stock-identity` | **The headline.** An out-of-scope page is **byte-identical to a stock load**: nothing of ours adopted, root flag absent, zero nodes of ours, and the same `<html>` attributes and body colours as the same URL loaded with the registration removed. |
| `lifecycle` | **N document-start copies leave one of everything** — three by default, because a symptom linear in copy count makes a two-copy test look exactly like the bug [F-BOOT-LISTENER-SURVIVES-TEARDOWN] — and the last copy **still applies**, so a teardown contract has not been traded for an init flag. |
| `teardown` | Own UI gone, root flag gone, our sheet no longer adopted, **purged chrome back**, stock surface rendering. |
| `degradation` | Break the anchor **at document-start** and assert the page renders **stock**, not mangled — and that the purge **reverted** rather than abstained. The test that proves the failure mode. |

**Two groups were deleted when the scope narrowed, and are not coming back by default:**
`drawer` (open by control, Escape, trusted click-outside, focus trap, `inert`) and
`actions` (a configured list of **relocated** controls that must still act). Both verified
machinery the keep-list deletes rather than builds. The one assertion worth keeping from
`actions` — *a control that renders is not a control that works* — lives on in `pagination`,
against the one control the keep-list keeps.

Not generalised, and deliberately still hand-written per site: anything belonging to the
**relocation exception** — a moved control that must still act, a drawer's focus trap and
dismissal, **dialog** dismissal at all [F-BACKDROP-ADJACENCY] — plus **reduced motion**
(faded elements visible under `prefers-reduced-motion: reduce`, not stuck at `opacity: 0`)
and **performance** numbers — inject time and any remap cost. Write those as a `.mjs` spec
against `scripts/userscript-acceptance.mjs`.

## Five ways a spec lies to you

0. **The rig itself is dead.** A CDP target can silently stop delivering trusted
   press/release while still delivering `mouseMoved`, so every control reads as "renders
   correctly, does nothing" and the redesign takes the blame [F-INPUT-SILENTLY-DROPPED].
   **Assert liveness on a plain stock control before trusting any null result.** This one
   is listed first because it invalidates the other three rather than competing with them.

1. **A fixed sleep races a transition** [F-TRANSITION-RACE]. Poll with `settle()` until
   the value stops changing. Two equal reads are not proof for anything that grows in
   steps — raise `stableFor`.
2. **A background tab breaks three things at once** — `IntersectionObserver` delivers
   nothing [F-IO-BACKGROUND-TAB], transitions never tick so `settle()` confirms a stock
   value as "stable", and a frozen transition **pins its property above author-`!important`**
   [F-BG-TAB-FREEZES-ANIM]. These present as unrelated defects (lazy-loading broken,
   colours unreached, clicks not navigating) and clear together the moment the tab has a
   live clock. **Reach for `Emulation.setFocusEmulationEnabled`, not `Target.activateTarget`**
   [F-FOCUS-EMULATION]: it fixes all three without stealing the operator's window, and
   several agents sharing one browser stop fighting over which tab is frontmost.
   `Page.setWebLifecycleState` does **nothing** for this — do not ship it as half of a pair.
3. **Ordering inside a spec.** A check placed after the one that changed the page runs
   against the changed state and passes for the wrong reason — a dismissal check after an
   Escape check meets an already-closed dialog; a rest-state read after a trusted click
   meets a pointer still parked on the element. Make each assertion **establish its own
   precondition**.
4. **The failure is in YOUR paint, not the site's.** A sub-AA pair that the contrast audit
   reports may be your own static sheet and your own repaint fighting each other, each
   right by its own rule — and it can stay invisible until something that was hidden
   becomes visible [F-SHEET-VS-REPAINT-FIGHT]. Check whether the surface is one you painted
   before hunting for a rule the theme missed.

## When a check fails, suspect the spec as readily as the code

In one reference implementation, **three** failing specs were themselves the bug: a
check ran against an already-closed dialog; a probe element was hidden by the
redesign's own rule because it had been appended to `body`; and a strip needed 60 key
presses where the spec sent 12. Each looked like a product defect and was not.

The discipline: before changing the script to satisfy a failing check, prove the check
measures what it claims. Then fix whichever is actually wrong — and if it was the spec,
say so rather than quietly editing it.

## Reporting

Counts and figures, never adjectives. `25/25 filters, 14/14 hardening, 82 ms inject,
1690 rules remapped in 23 ms` is a result. "All tests pass, performance is good" is not.

End the run with the plugin's standard report block —
[`../../references/report-format.md`](../../../references/report-format.md).

## Where to read next

- [`SKILL.md`](../SKILL.md) · [`relocation.md`](relocation.md) · [`theming.md`](theming.md)
- [`../../references/facts.md`](../../../references/facts.md) — every `[F-…]` above.
