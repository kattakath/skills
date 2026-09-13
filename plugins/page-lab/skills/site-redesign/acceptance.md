# Verifying a redesign

**Geometry proves a control is present. It never proves it works** [F-PRESENT-NOT-WORKING].
A redesign is verified when every primary action still works under a **trusted** event —
`Input.dispatchMouseEvent` and `Input.dispatchKeyEvent`, never `el.click()`.

Build the suite on `scripts/userscript-acceptance.mjs` and `scripts/lib/harness.mjs`.
Hand-rolling a CDP driver for this is the reinvented wheel; the harness already carries
the node-without-`WebSocket` re-exec [F-NODE-NO-WS], trusted input, and `settle()`.

## The groups

| Group | Must prove |
|---|---|
| **Primary surface** | Fills its container at every M11 width. **No horizontal overflow** on the document element. Unit count and aspect ratio match the survey. |
| **Units** | Organic count matches stock; promoted count is **zero**; a unit's link still navigates under a trusted click. |
| **Theme** | A measured contrast ratio for **every** text-on-background pair, each at or above target. No stock light colour left behind. No unstyled flash at `document-start`. |
| **Shell** | Opens and closes by control, by Escape, and by **trusted click-outside**. `aria-expanded` tracks. Focus trapped, then **restored**. Background `inert`. |
| **Relocated controls** | **Each one still performs its action** — search submits, a filter filters, pagination pages. One assertion per control; there is no sampling here. |
| **Dialogs** | Every dialog dismisses by **both** Escape and trusted click-outside, with the shell still open behind it [F-BACKDROP-ADJACENCY]. |
| **Lifecycle** | Inject **twice**: exactly one panel, one control, one sheet. Teardown restores stock — relocated nodes back at original parent **and** next sibling, site classes restored. |
| **Degradation** | Break a site selector by hand and assert the page renders **stock**, not mangled. This is the test that proves the failure mode. |
| **Reduced motion** | Under `prefers-reduced-motion: reduce`, faded elements are **visible** — not stuck at `opacity: 0`. |
| **Performance** | Inject time, and any remap cost, as **numbers**. |

## Three ways a spec lies to you

1. **A fixed sleep races a transition** [F-TRANSITION-RACE]. Poll with `settle()` until
   the value stops changing. Two equal reads are not proof for anything that grows in
   steps — raise `stableFor`.
2. **An observer-driven spec stalls in a background tab** [F-IO-BACKGROUND-TAB].
   `IntersectionObserver` delivers nothing until the target is activated, and the
   resulting false negative looks exactly like broken lazy-loading.
3. **Ordering inside a spec.** A dismissal check placed after an Escape check runs
   against an already-closed dialog and passes for the wrong reason. Re-open between
   assertions, and make each assertion establish its own precondition.

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
[`../../references/report-format.md`](../../references/report-format.md).

## Where to read next

- [`SKILL.md`](SKILL.md) · [`relocation.md`](relocation.md) · [`theming.md`](theming.md)
- [`../../references/facts.md`](../../references/facts.md) — every `[F-…]` above.
