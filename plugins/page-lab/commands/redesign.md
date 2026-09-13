---
description: Redesign a whole site as a userscript — dark theme, a new primary surface, the site's own controls relocated into an overlay. Survey the live page first, then build in parallel.
argument-hint: <site-or-url> <the experience you want>
---

Run the **`site-redesign`** skill from this plugin, end to end, for: `$ARGUMENTS`

**First decide it is the right skill.** If the wish is one element, one rule or one
annoyance, run **`userscript-author`** instead and stop here. This skill is for an
alternative experience: every surface recoloured, the site's own controls moved, a new
shell.

## Sequence

- **0. Route before anything.** `bash ${CLAUDE_PLUGIN_ROOT}/scripts/page-route.sh`. It prints
  `ROUTE_SHELL=` and an `AGENT-MUST-CHECK:` block naming the checks a shell cannot make; make
  them and re-run with `--tools` for the final `ROUTE=`. If a gate is shut,
  `bash ${CLAUDE_PLUGIN_ROOT}/scripts/route-up.sh --tier <n>` says how to open it. **Do not
  improvise past a dark gate** — most "broken selector" reports are an unreachable browser.

- **0.5. Check the shelf.** Fetch the by-site index on greasyfork.org (and sleazyfork.org if
  the site is adult-adjacent) for the **bare** domain. A hit is evidence to read for its
  measured selectors, never a dependency to `@require`. Record: hit (adapted) / hit
  (rejected, why) / empty.

- **1. SURVEY — blocking.** Run `skills/site-redesign/survey.md` M1 to M12 against the
  **stock** page. No selector may be written until it is done. Write the dated table to a
  file the later phases read.

  Report M2, M4, M6, M8, M10 and M12 first — those six change what everyone else builds.
  **M12** (a stock dark theme exists) and **M6** (handlers delegated to an ancestor) can
  each invalidate the plan outright.

- **2. DESIGN — in parallel**, once the survey lands: **Theme**, **Grid/Content**, **Shell**.
  They share one palette and one own-UI exclusion list; name both in the survey output so
  three agents do not invent three.

- **3. INTEGRATE.** One IIFE, no build step. The integrator's job is subtractive: one
  palette, one exclusion list, one duration scale, one lifecycle object, one teardown.

- **4. VERIFY.** `skills/site-redesign/acceptance.md`. Trusted events only. Numbers, not
  adjectives. Suspect the spec as readily as the code.

- **5. SHIP.** Both gates. **Bump `@version` first** — a same-version re-install is a silent
  no-op. Then tell the operator the step only they can do: re-install, and **reload every
  open tab**.

## Ask, do not assume

Put genuinely open scope questions to the operator as **click-to-select options,
recommended first** — which surfaces are in scope, whether metadata shows always or on
hover, whether to add seamless pagination. Resolve them in the survey phase, not by
guessing during the build.
