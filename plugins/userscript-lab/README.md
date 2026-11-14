# userscript-lab

Author **Violentmonkey userscripts** and **redesign whole sites** with a measure-first
method, verified through **Claude in Chrome** in the operator's own Chrome. Ships the Greasy
Fork readiness linter.

| You say | Skill |
|---|---|
| *"make this site do X"*, *"hide this banner"*, *"write a userscript"* | `userscript-lab:userscript-author` — shelf-check → measure A/B → diff → write → lint → install → prove |
| *"my script stopped working"* | `userscript-lab:userscript-author` — re-measure, re-diff, re-prove: the page changed, your memory of it did not |
| *"redesign this site"*, *"dark mode the entire site"* | `userscript-lab:site-redesign` — M1-M13 survey → keep-list build → verify → harden → ship |

## The one invariant

**MEASURE.** Never ship a selector, class or breakpoint that was not dumped from the live
page. A plausible-looking selector nobody measured is the single most common way a userscript
silently stops working on the site's next deploy.

The corollary is the method's whole point: **before writing UI, check whether the site already
renders the state you want** — a narrow-viewport layout, a print stylesheet, a logged-out view.
If it does, replaying its own condition beats reimplementing it, and ships without a single one
of the site's generated class names.

## The rail, and the guarantee it does not give

Every measurement runs through Claude in Chrome's `mcp__claude-in-chrome__*` tools
(`javascript_tool` for probes, `read_page` / `find` for candidates, `computer` for real clicks
and keys, `resize_window` for widths, `read_console_messages` / `read_network_requests`,
`gif_creator` for proof). They are deferred tools: load them in **one** ToolSearch `select:`
call. A per-site permission prompt is the operator's to answer; the skills wait rather than
route around it.

**What this rail buys:** it measures the page in **the profile the script ships into** — the
operator's logins, extensions and Violentmonkey — so post-install proof is real.

**What it cannot give**, stated in both skills verbatim:

> No trusted-event or `document-start` proof is available on this rail: Claude in Chrome runs
> after load, in an untrusted context. Verify by installing in Violentmonkey and checking with
> Claude in Chrome; say which checks ran.

The evidence for why that matters: a suite of **88 checks reported 0 failures** on a build with
**five live defects**, because every check evaluated the script into an already-loaded page
while the installed script runs at `@run-at document-start` [F-INJECT-IS-NOT-INSTALL]. So
every report names its NOT RUN checks rather than rounding them up to a pass.

Its four silent traps (block scope per call, an output sanitizer that rewrites values without an
error, a post-call origin re-check, the per-site prompt) and the shapes that avoid them are in
`skills/userscript-author/references/probes.md`.

## Two scales of change

`userscript-author` owns the single change: hide a banner, fix a rotted selector, restyle one
element. **`site-redesign` starts where that escalates** — every surface recoloured, a new
shell, work large enough to need a survey first. The second does not relax the first: same
gates, same metadata bans, same anchors-are-roles rule, same degrade-to-stock failure mode.

## Layout

| Piece | What it owns |
|---|---|
| `skills/userscript-author/` | The single-change loop; `references/probes.md` (the four probe bodies), `patterns.md` (reuse ladder, vetted code shapes, live-edit loop), `gm-api.md`, `greasyfork.md` |
| `skills/site-redesign/` | The whole-site method: the M1-M13 survey and the verify checklist in `SKILL.md`; `references/keep-list.md` (the default shape), `topbar.md`, `theming.md`, `relocation.md`, `overlays.md`, `hardening.md`, `rules.md` |
| `scripts/userscript-meta-lint.sh` | Greasy Fork readiness: `node --check`, required/banned metadata keys, dotted-numeric `@version`, minified output, vendored attribution |
| `tests/no-cdp.sh` | The plugin's own gate: no DevTools-protocol residue, and both skills state the guarantee sentence verbatim |

## The linter

```bash
scripts/userscript-meta-lint.sh <path.user.js|dir>
```

Wire it into a userscript repo's CI:

```yaml
- run: plugins/userscript-lab/scripts/userscript-meta-lint.sh userscripts/
```

Lint says the file is publishable; it never says the script works. A real script shipped with
its search button present, sized and hit-testable, and **inert** under a real click
[F-PRESENT-NOT-WORKING] — which is why both skills exercise primary actions after install.

Requires `bash` and `node`.

## Facts are dated, not remembered

`[F-ID]` tags cite rows of the facts table this plugin inherited from its predecessor; each
fact is stated in the prose beside its tag. The full table, with dates and reproduction
recipes: `git show f110f8d:plugins/page-lab/references/facts.md` in this repo.

## Safety posture

- **An agent cannot install a userscript or flip a `chrome://extensions` toggle.** *Allow User
  Scripts* (Chrome 138+) and every install click are always the operator's.
- **Work in tabs the agent opened**, never close the last tab, never trigger a modal dialog —
  a modal stops the extension answering.
- **Never a secret in a userscript.** It is plain text that ships to the browser.

## Licence

MIT.
