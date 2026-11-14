---
name: userscript-author
description: >
  This skill should be used when the user asks to make a site do X ("make <site> do X"),
  write a userscript for a site, fix a broken userscript, remove or restyle an element
  that annoys them ("this site's sidebar annoys me", "hide this banner"), or publish a
  userscript to Greasy Fork. It authors a lint-clean Violentmonkey `.user.js` by
  measuring the live page first through Claude in Chrome — never by guessing a selector.
---

# Userscript author — measure → replay → write → lint → install → prove

**The invariant is MEASURE.** Never ship a selector, class or breakpoint that was not dumped
from the live page. **If the page cannot be reached, say so and stop** — asking the operator
to paste a probe result is a measurement; inventing a selector is not.

This skill owns the *judgment*: is the wanted state **already rendered** by the site, which
selectors are **real**, what gets **asked** instead of guessed.

```
wish → shelf → open tab → measure A vs B → diff → replay-or-select → write → lint → install → prove
```

**The rail is Claude in Chrome**, in the operator's own Chrome — the same profile, logins and
Violentmonkey the script ships into.

No `document-start` proof is available on this rail: Claude in Chrome injects only after load. Its `computer` clicks and key presses are trusted (`isTrusted: true`, measured 2026-11-14). Verify by installing in Violentmonkey and checking with Claude in Chrome; say which checks ran.

**Delivery is out of scope.** This skill stops at a lint-clean, installed, proven file.

## Hard rules

1. **Never `@require` / `@resource` from a CDN.** Fetched at install time, **no SRI or
   integrity field exists**, nothing pins it; Violentmonkey also refuses local files. Reuse
   enters as **vendored source**, which Greasy Fork permits *provided* the block carries
   name/version/URL attribution ([`greasyfork.md`](references/greasyfork.md)).
2. **Every shipped selector is listed in the file's WHY block with the date it was measured.**
   A **template-literal selector containing `${`** is banned — untraceable to a measurement.
3. **`@grant none` is the target.** Every grant comes from the verified set in
   [`patterns.md`](references/patterns.md) § 6 — no linter checks grant *values*, so **a typo grants
   nothing, silently**. Portability: [`gm-api.md`](references/gm-api.md).
4. **`@match` + `@noframes` by default** ([`patterns.md`](references/patterns.md) § 7). `@downloadURL` /
   `@updateURL` / `@installURL` are **lint-enforced bans** ([`greasyfork.md`](references/greasyfork.md)).
5. **Never a secret.** A userscript is plain text that ships to the browser and usually gets
   copied somewhere world-readable. A private repo is not a secret store.
6. **A located element is a measurement only when** `javascript_tool` has shown
   `document.querySelectorAll(sel).length === 1` (or the exact count the script expects) on
   the page it ships against, and its reachability is known (`el.getRootNode() === document`,
   `window.top === window`). A shadow root → [`patterns.md`](references/patterns.md) § 11; a cross-frame target → `@match` the frame's own URL and drop `@noframes`. A `find` hit or a screenshot is a **lead**, never a selector.

## Checklist (run in order)

### 0. Check the shelf first — reuse over rebuild

Authoring is the **fallback**. Both hosts publish a free, no-auth **by-site index**, so "has
someone already solved this" is one fetch. Mechanics and the Sleazy Fork split:
[`greasyfork.md`](references/greasyfork.md) § The shelf check.

- [ ] Fetch `https://greasyfork.org/en/scripts/by-site/<domain>` for the **bare** domain
      (`civitai.com`, not `www.civitai.com`), and Sleazy Fork too if the site is adult-adjacent.
- [ ] A hit is **evidence, not a dependency.** It still cannot be `@require`d (rule 1) and must
      not be pasted unread. Read it for its **measured selectors and its condition**, then vendor
      *with attribution* or re-derive.
- [ ] Record: **shelf hit (adapted) / hit (rejected, why) / empty**. "Nobody looked" and
      "nothing exists" must not read the same.

### A. Frame the wish

- [ ] Which **exact URL** (it becomes `@match`), and which **state is "good"**?
- [ ] Is that state reachable **without code** — a narrower window, another route, a site
      toggle? Then the job may be a bookmark. Greasy Fork's Functionality rule: a script must
      "have a reason to be a script".
- [ ] Anything a stated preference does not cover → **ask**. Colour, typography, density and
      "which furniture goes" are never obvious.

### A.5 Open the page — Claude in Chrome

- [ ] The tools are deferred. Load them in **ONE** ToolSearch call:
      `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__find,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__resize_window,mcp__claude-in-chrome__read_console_messages,mcp__claude-in-chrome__tabs_close_mcp`.
- [ ] `tabs_context_mcp` first (it answers *not connected* when the extension is down — that
      is not shell-probeable, so this call **is** the probe), then `tabs_create_mcp` +
      `navigate` to the exact URL. Reuse an operator tab only when asked to.
- [ ] **A per-site permission wall is the operator's call.** The first script on a new domain
      raises the extension's per-site prompt: tell the operator and wait. Never route around
      it with another browser or protocol; a declined site is a stop.
- [ ] The not-connected / declined fallback is the paste route: hand the operator the probe
      body for their own DevTools console and take the JSON back ([`probes.md`](references/probes.md)).

### B. Measure state A (what the site renders stock)

- [ ] Run **`dumpSubtree(rootSelector)`** ([`probes.md`](references/probes.md)) through
      `javascript_tool`, **storing the payload on `window`**. The tool silently truncates
      large output, so diff in the page and return only the summary (probes.md § Running on
      Claude in Chrome).
- [ ] Run **`mediaRules()`**; note `crossOrigin` — a high count means the replay route may be
      unavailable, and this rail has no engine-side way around it.
- [ ] When the operator is pointing rather than describing, use `find` or `read_page` to get
      **candidates**, then prove each with `querySelectorAll(sel).length` (rule 6). A
      `computer` screenshot shows the human what you mean; it is not the measurement.

### C. Measure state B (the good state)

- [ ] Put the page in state B, re-run **`dumpSubtree`** on the same root, record `innerWidth`.
- [ ] **When the trigger is a width, set it with `resize_window`** — repeatable and
      bisectable. It sets the **window**, not the viewport: read `innerWidth` from the probe,
      never assume it from the size you asked for.
- [ ] Otherwise resize / route / toggle **by hand** — the measurement matters, not who took it.

### D. Diff → verdict

- [ ] Run **`diff(a, b)`** ([`probes.md`](references/probes.md)). An **empty diff is the finding**, not a
      failure. Probe 3's own table maps the counts to the three verdicts — **DOM-DIFFERS**,
      **DOM-IDENTICAL**, **STATE-B-UNREACHABLE** — and what each one licenses.
- [ ] On DOM-IDENTICAL, **no selector can force a media query**: lift the site's rules **by
      condition in a band, never a hardcoded pixel**, accumulating **every block** at each width
      before picking one ([`patterns.md`](references/patterns.md) § 5). Reimplementing a state the site
      already renders is the classic loss.
- [ ] **Prototype the override live before writing a file.** Inject the candidate CSS into the
      running page with `javascript_tool` (a scratch `<style>` or adopted sheet), check it,
      **reload**, and promote only what survived. A rule that needed `!important` in the
      prototype needs it in the file — one that did not **must not** carry it.

### E. Write the body

- [ ] Work **down the reuse ladder** in [`patterns.md`](references/patterns.md), first hit wins: platform
      web API → metadata key → granted `GM_*` → vendored source. Take the navigation, waiting,
      CSS-injection and idempotence shapes from there; do not improvise them.
- [ ] Open the WHY block with the **measured finding, one sentence**, then the dated selectors.
- [ ] **Degrade to stock, never mangle.** A script that cannot do its job becomes a no-op.

### F. Lint

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/userscript-meta-lint.sh" <file.user.js>   # or a directory
```

`node --check`, required/banned metadata keys, dotted-numeric `@version`, minified or bundled
output, and vendored attribution. What it **cannot** check: [`patterns.md`](references/patterns.md) § 10.

### F.5 Install and exercise the host's primary actions

**Lint plus geometry is not a gate.** A shipped script passed both with its search completely
dead: the button was present, 40x40, on top at its own centre, and inert under a real click —
`activeElement` stayed `BODY`. `getBoundingClientRect` proves a control is *present*; only
operating it proves it *works*.

- [ ] **Install in Violentmonkey** — the operator's click (§ Install reality), or a tracked
      file (patterns.md § 12). Then **reload** the tab.
- [ ] Every **primary action of the host** still works: click it with `computer` (a real
      pointer click, never `el.click()` from `javascript_tool`), then read the effect with
      `javascript_tool` (`document.activeElement`, the target's rect, `location.pathname`).
      That is the thing the user came to the site to do, plus anything the script moved, hid or
      floated over.
- [ ] Anything the script **relocated** is exercised where it now lives, not where it was.
- [ ] **Teardown returns the page to stock** — call the script's teardown global from
      `javascript_tool`, then confirm moved nodes are back at their original parent and
      next-sibling.
- [ ] A **second injection** does not livelock: that is the Greasy Fork install plus a manual
      one, which is the case the teardown contract exists for.
- [ ] Never assert at a fixed delay. Poll until the value stops changing, and raise the
      stability count for anything that grows in steps.

### G. Prove it after install

- [ ] Re-run **`assertEffect()`** + **`dumpSubtree`** and **diff against the recorded state B**.
      Eyeballing is not a check.
- [ ] This rail measures the page in **the profile the script ships into**, so a converged
      diff here is real post-install evidence — but it is still read after load, so name any
      check that depends on `document-start` timing as **not run**.
- [ ] A missing marker usually means the script **never ran** — check § Install reality first.
- [ ] `read_console_messages` with a `pattern` for the script's own log prefix catches a
      throw the page swallowed. A `computer` screenshot or a `gif_creator` recording is
      proof **for the operator**; the JSON diff is the measurement.

### H. Publish

[`greasyfork.md`](references/greasyfork.md) — rulebook, metadata contract, adult-content marking, and how
to make a `git push` the release without `@updateURL`.

### I. Escalation trigger (do not grow a bundler)

- [ ] **≥ 4 scripts**, **or** the first TS/JSX need, **or** `GM_*` plus a settings UI ⇒ **STOP.**
      Ship nothing; propose adopting **`vite-plugin-monkey`** as its own change.
- [ ] Never hand-roll a build step; never commit minified or bundled output (Greasy Fork
      rejects it, the lint fails it).

## Editing an existing script

**Bump `@version` first** — dotted-numeric; a same-version re-install is a **silent no-op**.
**Re-measure before re-writing** (B–D): the page changed, the recorded measurement did not. Then
re-lint (F), re-install and re-prove (F.5, G).

**The operator's profile already runs the old version.** Before any live test of the new one,
settle which copy you are measuring: [`patterns.md`](references/patterns.md) § 13.

## Install reality (Chrome)

One-time per profile on Violentmonkey's `chrome://extensions` details page: **Allow User
Scripts** (Chrome 138+ requires it; scripts silently never run without it), plus **Allow
access to file URLs** for a `file://` install. An agent **cannot** flip a toggle or drive the
manager's confirm dialog — that click is the operator's. Why the toggle exists and why policy
cannot set it: [`gm-api.md`](references/gm-api.md).

**Iterating without re-installing by hand:** Violentmonkey's *Track external edits* turns each
save into an auto-reinstall plus a tab reload. Setup, and the three silent ways tracking dies
(a git write to the file being the worst): [`patterns.md`](references/patterns.md) § 12.

## Anti-patterns

CDN `@require`/`@resource` ([`patterns.md`](references/patterns.md) § 9) · `setInterval` polling for a URL
or an element (§ 1, § 2) · `document` + `subtree: true` on a virtualised list (§ 2) ·
`!important` escalation to win the cascade (§ 4) · hardcoded generated class names where a
condition exists (§ 5) · shipping a selector from a `find` hit or a screenshot without a
count (rule 6).

## End every run with this report

```markdown
## Userscript report
- **Wish:** (URL + the state asked for)
- **Shelf:** hit-adapted | hit-rejected (why) | empty — (which index/indices were fetched)
- **Measured:** (probes run, `innerWidth` A/B, cross-origin sheet count)
- **Diff verdict:** DOM-DIFFERS | DOM-IDENTICAL | STATE-B-UNREACHABLE
- **Approach:** (attribute set | rules lifted by condition in band X–Y | constructed UI)
- **Selectors shipped:** (each one, with the date measured — or "none")
- **Lint:** ✅/❌
- **Checks ran:** (which F.5/G checks ran on Claude in Chrome; which did not, e.g. document-start timing)
- **Operator action:** (install / toggle / publish — whatever a human must click)
- **Verdict:** SHIPPED | BLOCKED (why) | ESCALATED (vite-plugin-monkey)
```

## Where to read next

- [`probes.md`](references/probes.md) — the four probe bodies, how to run them on Claude in Chrome, the verdict table.
- [`patterns.md`](references/patterns.md) — reuse ladder, vetted code shapes, live-edit loop.
- [`gm-api.md`](references/gm-api.md) — `GM_*` portability, `@grant` asymmetry, metadata traps.
- [`greasyfork.md`](references/greasyfork.md) — the publishing rulebook.

`[F-…]` tags in the references cite rows of a facts table that shipped with this plugin's
predecessor; the fact itself is stated beside each tag. The table with its dates and
reproduction recipes: https://github.com/kattakath/skills/blob/f110f8d7780d1bbdd68b9b87824281d2188d8a92/plugins/page-lab/references/facts.md.

**Out of scope:** delivery (the fleet's own skill), whole-site redesigns
(`userscript-lab:site-redesign`), and general page diagnosis (Claude in Chrome's own skill).
