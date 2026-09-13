# page-lab

Author **Violentmonkey userscripts** and **diagnose live pages** from one place.

Built around four sentences an operator actually says:

| You say | It runs |
|---|---|
| *"make this site do X"* | `/userscript` — shelf-check → measure A/B → diff → write → lint → publish |
| *"this element annoys me"* | `/pick` — you click the element, the agent measures that exact node |
| *"why is this slow / what request failed"* | `/devtools` — traces, network, console with source-mapped stacks |
| *"my script stopped working"* | re-measure, re-diff, re-verify — the page changed, your memory of it did not |

## The one invariant

**MEASURE.** Never ship a selector, class or breakpoint that was not dumped from the live
page. A plausible-looking selector nobody measured is the single most common way a userscript
silently stops working on the site's next deploy.

The corollary is the method's whole point: **before writing UI, check whether the site already
renders the state you want** — a narrow-viewport layout, a print stylesheet, a logged-out view.
If it does, replaying its own condition beats reimplementing it, and ships without a single one
of the site's generated class names.

## Why one plugin and not two

These were two plugins that cross-referenced each other. That held only while neither needed
the other mid-motion. The verb that broke it is **pick**: point at an element → measure that
exact node → read its cascade → prototype the override live → date it in the `WHY` block → lint
it → prove it after install. Under the split that motion crossed the plugin boundary four times
and needed a seam *file* to narrate the crossing. A seam that needs its own document is a merge
that has not happened yet.

**The cost, stated plainly:** the diagnosis half is no longer adoptable on its own. Anyone who
wants only page diagnosis also installs the userscript machinery. Softened by keeping
`page-diagnose` a self-contained skill with its own references and its own `/devtools`, not
removed.

## Two scales of change

`userscript-author` owns the single change: hide a banner, fix a rotted selector, restyle one
element. **`site-redesign` starts where that escalates** — every surface recoloured, the site's
own controls relocated into a new shell, work large enough to split across parallel agents. The
second does not relax the first: same two gates, same metadata bans, same anchors-are-roles rule,
same degrade-to-stock failure mode. It adds a blocking survey phase, because a redesign that
guesses a selector does not fail loudly — it mangles the page.

## Layout

| Piece | What it owns |
|---|---|
| `skills/userscript-author/` | The authoring method, `patterns.md`, `probes.md`, `greasyfork.md`, `gm-api.md` |
| `skills/site-redesign/` | Whole-site redesign: the M1-M13 survey, the `keep-list.md` default shape, `topbar.md`, `theming.md`, `acceptance.md` |
| `skills/page-diagnose/` | Symptom-first diagnosis, `attaching.md`, `tools.md` |
| `references/facts.md` | **Every falsifiable claim, once**, with an ID, a date and a re-measure recipe |
| `references/routes.md` | The five routes: gate, probe, how to open, fidelity, disarm obligation |
| `references/pick-protocol.md` + `pick-envelope.schema.json` | The pick contract |
| `references/cdp-extras.md` | Raw-CDP surface no MCP tool exposes, as symptom → command |
| `scripts/` | Everything deterministic — the picker, the validator, the linter, the route probe, the survey recon, the two acceptance runners |
| `scripts/lib/` | `cdp.mjs` (one CDP client), `harness.mjs` (trusted input, `settle`, the document-start lab), `redesign-checks.mjs` (the check groups) |
| `scripts/redesign.config.example.mjs` | The shape a new site fills in — the **keep-list** redesign, written out in full |

## Scripts

```bash
scripts/page-route.sh                      # which route is available right now
scripts/route-up.sh                        # how to OPEN a route, not just name it
scripts/userscript-meta-lint.sh <path|dir> # Greasy Fork readiness
scripts/pick-validate.mjs --self-test scripts/fixtures
scripts/devtools-doctor.sh                 # CDP connection preflight
scripts/survey-recon.mjs --origin <url> --shapes a=/,b=/x   # M1-M4, M10-M12, measured
scripts/userscript-acceptance.mjs <spec>   # does ONE change still WORK? (trusted events)
scripts/redesign-acceptance.mjs <config>   # does the WHOLE redesign work? (document-start)
scripts/redesign-acceptance.mjs --diagnose <config>   # facts per URL shape, no verdicts
scripts/stylesheet-media-extract.mjs <url> # does the site already ship a compact layout?
node scripts/pick-element.mjs              # arm the picker (or the page-lab-pick CLI)
```

`userscript-acceptance.mjs` is the gate the linter is not. Lint says the file is publishable
and `selector-verify.mjs` says the nodes are there; neither says the redesign still works.
A real script shipped through exactly that gap — its search button was present, sized and
hit-testable, and inert under a trusted click [F-PRESENT-NOT-WORKING]. The spec is a `.mjs`
module living beside the `.user.js` it tests, so the script's own repo needs no test runner.

**`redesign-acceptance.mjs` is the gate `userscript-acceptance.mjs` is not**, and the
difference is not the assertions — it is the world they run in. A suite of **88 checks
reported 0 failures** on a build with **five live defects**, because every check evaluated
the script into a page at `readyState: "complete"` while the installed script runs at
`@run-at document-start` [F-INJECT-IS-NOT-INSTALL]. Six document-start probes found all
five in minutes. So this runner injects with `Page.addScriptToEvaluateOnNewDocument`,
drives real navigations, and keeps the tab's clock live without taking over the operator's
window [F-FOCUS-EMULATION]. **A new site is a config file, not a program** — and the config
is short, because the groups follow the **keep-list**: the grid applies, everything else is
gone, the topbar autohides, pagination survives and still navigates, **an out-of-scope page
is byte-identical to a stock load**, N document-start copies leave one of everything,
teardown restores, a broken anchor degrades to stock. Each group skips loudly, naming the
missing config path, rather than silently passing when its config is absent.

Wire the linter into CI:

```yaml
- run: plugins/page-lab/scripts/userscript-meta-lint.sh userscripts/
```

Requires `bash`, and `node` for the `.mjs` scripts. Zero npm dependencies.

## Facts are dated, not remembered

`references/facts.md` is the single source of volatile truth. Every other file states a
falsifiable fact in at most one clause and cites `[F-ID]`. Rows marked **UNVERIFIED** are
promoted only by re-running their recipe and dating the result — never by tidying the table.

That discipline is not decoration. Measured examples currently in the table:

- `chrome-devtools-mcp@1.8.0` ships **29** tools, not the ~57 its generated docs describe —
  so the entire Extensions group does not exist, and any plan built on `install_extension`
  fails at the first call.
- `$0` is **not** readable from a separate CDP session. Do not retry it.
- `Overlay.setInspectMode({mode:'none'})` **rejects** unless `highlightConfig` is passed on the
  *disarm* too — which is why one `try/catch` around a disarm loop leaves every tab armed.

## Safety posture, inherited and non-negotiable

- **An armed picker swallows the next click on every armed tab.** Every disarm is guarded
  independently, with a timeout, a signal handler and a detached watchdog.
- **An open remote-debugging port is an unauthenticated control channel** — any local process
  can drive that browser and read its cookies and session state. Hand-run only, never a launchd
  agent or login item, closed when the work ends.
- **Both telemetry flags on every `chrome-devtools-mcp` invocation** — `--no-usage-statistics`
  *and* `--no-performance-crux`; the second otherwise sends **traced URLs** off-machine.
- **Never present lab data as field data.** A local trace is one sample on one machine.
- **An agent cannot install a userscript or flip a `chrome://extensions` toggle.** That click is
  always the operator's.

## Licence

MIT. `chrome-devtools-mcp` is Google's, under its own licence.
