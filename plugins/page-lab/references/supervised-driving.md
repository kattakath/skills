# Supervised driving — the agent drives, the operator watches

How the pieces fit, what was measured, and what is deliberately not solved. The agent-facing
procedure is `../skills/supervised-driving/SKILL.md`; this file is the evidence. Facts are
cited by ID and owned by `facts.md`.

## The mechanism (one bridge, reused)

```
agent ── supervise.mjs ──► stamp file (state, reason) ◄── daemon ── CDP socket ── every tab
                                                            ▲            │
   page: window.__pageLab ── Runtime.addBinding signal ─────┘            └─ addScriptToEvaluateOnNewDocument
```

- Same parts as the picker: `lib/cdp.mjs` (one socket), a `Runtime.addBinding` callback
  (`cdp-extras.md`), and a detached process that holds the socket (`pick-watchdog.mjs`'s
  pattern) [F-SUPERVISE-BINDING-BRIDGE]. Only the payload, `scripts/supervise-overlay.js`, is new.
- The **stamp file** (`$TMPDIR/page-lab-supervise.json`) is the one source of truth, because page
  state dies with every navigation. A new document says `hello`; the daemon answers with the stamp.
- The daemon also pushes the stamp to every tab each 1.5 s. A page that hears nothing for 15 s
  drops its layer: **fail-open**, so a dead supervisor never locks the operator out.

## States

| State | Layer | Operator input | Enters by | Leaves by |
|---|---|---|---|---|
| `agent` | on, ~12 % tint, top pill | swallowed | `start`, hand-back, `need-human` return | Esc / pill click → `human`; `need-human` → `intervene` |
| `human` | off, chip bottom-right | free | Esc or pill click | the **Hand back to Claude** chip (only the operator) |
| `intervene` | off; amber banner with the reason **on the target tab only** | free | `need-human` | `--until` holds on the target tab, **Done**, timeout |
| `pending` | off | free | before the daemon speaks; after 15 s without it | any daemon message |

## Passthrough: arm, then act

CDP input is `isTrusted:true`, indistinguishable from the operator's [F-SUPERVISE-TRUSTED-SAME].
So `__pageLab.pass(ms, {keys, once})` opens a window in which the layer ignores input; it
returns `{ok:false}` in `human`/`intervene` — the one mechanical "do not act" signal there is.

**Cooperative, not enforced.** An agent that skips the arm is only swallowed. An operator whose
input lands inside an open window is not stopped. Keep windows short; default 6000 ms is a
judgement, not a measurement (one MCP arm→click→fill→press_key round trip took ~1.1 s;
model think time is on top and was not measured).

Esc inside a window still barges in, unless the agent opted in with `{keys:["Escape"]}`.

Verified on `scripts/fixtures/supervise/` with `supervise-selftest.mjs` (45 checks) and, through the
real `chrome-devtools-mcp@1.12.0`, `supervise-measure.mjs`:

| Input | No window | Inside `pass()` |
|---|---|---|
| trusted click (raw CDP, MCP `click`) | swallowed | lands |
| `rawKeyDown`, `Input.insertText` (raw CDP) | swallowed | lands |
| MCP `fill`, `press_key` | swallowed | lands |
| Esc, default window | barge-in | barge-in |

## Intervention (`need-human`)

Resolve the target tab, bring it to the front, layer off, banner with the reason **on that tab**,
`osascript` notification plus a Glass sound via backgrounded `afplay` (`say` only if that fails), then poll every 500 ms for `--until`
(the target tab's URL, or a selector in the target tab) or the Done button; on return the layer is
back on. Exit 20 on timeout (default 540 s, under the Bash tool's 600 s cap) with the banner left up.

- **Which tab (the 2026-11-02 bug).** An agent opened Google's 2SV page with `supervise open`
  (a background tab, by design) and called `need-human`. The old code broadcast the state to
  every tab, so the banner landed on the visible Grafana tab and the real prompt sat hidden.
  Now: `--tab <targetId|url-substring>`, else `lastTab` in the stamp — set by `open` and by
  `__pageLab.pass` (the page signals `driven` to the daemon; the all-pages CLI `pass` sends
  `cli:true` and stays silent). The visible tab is never assumed, and no resolvable tab is exit 1
  with no banner anywhere. `stamp.target` makes `setExpr` hand `mine:false` to every other tab:
  held (`pass` refuses) but no banner.
- **The raise is `Target.activateTarget`** — measured 2026-11-02 (throwaway Chromium 152, Ghostty
  frontmost, `lsappinfo front`): Chromium became frontmost, the target's `visibilityState` went
  `visible` and the previous tab's `hidden`. So it is a window raise, gated like the `osascript`
  one. One exception that costs nothing: with the browser already the frontmost app, a repeat
  call still selects the tab (the operator may have wandered off it).
- **Use it only for human-only steps** — MFA/TOTP, passkey/Touch ID or Google re-auth, captcha.
  A Done banner for a decision already made in conversation is a prompt nobody is waiting to see;
  it timed out unseen in the same session. `--until` is the default resolution, Done the fallback.

- **Raise guard:** a stamp per reason in `$TMPDIR/page-lab-supervise/`, written *before* the
  raise, 10 min TTL. A repeat of the same reason notifies again but cannot raise. The tab
  activation is real in the selftest (it brings the throwaway Chromium forward); only the
  `osascript` calls are stubbed (`PAGE_LAB_SUPERVISE_NO_OSASCRIPT=1`).
- **Deliberately not wired: "Esc ends the intervention".** A login modal's Esc is habit; an early
  resume would put the agent's input into the operator's half-typed form. `--esc-ends` opts in,
  and still ignores Esc inside an input.
- `reason` goes into a notification: no secret values.

## Focus stealing — measured

Throwaway-profile Chromium 152 (`open -g -n`), a non-Chromium app frontmost before every probe,
`lsappinfo front` after 900 ms; 4 identical runs [F-SUPERVISE-FOCUS-TABLE].

| Call | Chromium frontmost? |
|---|---|
| MCP `new_page` (default) | **yes — steals** |
| MCP `select_page {bringToFront:true}` | **yes — steals** |
| MCP `list_pages`, `new_page {background:true}`, `navigate_page`, `take_snapshot`, `evaluate_script`, `take_screenshot`, `click`, `fill`, `press_key`, `select_page {bringToFront:false}`, `close_page` | no |
| CDP `Target.createTarget {background:true}`, `Emulation.setFocusEmulationEnabled`, `Input.dispatchMouseEvent` | no |
| CDP `Page.bringToFront` — the positive control | **yes** |
| CDP `Target.activateTarget` (what `need-human` uses) | **yes** — and flips `visibilityState` of the two tabs |

`AppleSpacesSwitchOnActivate` read `1`, so a steal also switches Space when the window is on
another one. The Space switch itself was not observed (one Space under test).

**Quiet is not the same as visible.** `new_page {background:true}` opens a tab that is *not
selected*, so the operator keeps looking at the old one. `chrome-devtools-mcp` (puppeteer) turns
focus emulation on for every page it manages, so all of its pages read `visibilityState
visible` and the tab the operator sees is **not readable over CDP**. Measured on raw targets:
foreground `visible/true`, background `hidden/false`, background plus
`Emulation.setFocusEmulationEnabled` `visible/true`. Hence the skill's rule: drive the visible
tab; raise on purpose, only to show a new one; a background tab is for work they need not
watch, and it keeps a live clock without any help of ours [F-BG-TAB-FREEZES-ANIM].

## Deviations from the brief, for the lead to overrule

- **Esc does not end an intervention by default.** Opt-in `--esc-ends` (ignored inside inputs).
  Reason above; one flag flips it.
- **Esc inside an open window still barges in.** The brief had no rule; chosen so the operator's
  Esc is never lost to an agent that never sends one.

## Not solved, on purpose

- Cross-origin iframes: the layer covers the top frame only.
- Two agents on one browser share one stamp and one state.
- The alert, partly. The un-stubbed `osascript display notification … sound name "Glass"` exited
  0 with empty stderr on 2026-11-02, but whether a banner or sound appeared was not observable
  from here, and on current macOS it posts as **Script Editor**, which needs its own notification
  permission. Recipe: `node -e` the call in `notify()` and watch the screen. `activate` was never
  run live (it would take the operator's focus); its argv and once-per-reason guard were tested stubbed.
- **Main-world exposure.** The payload runs in the page's world so `evaluate_script` can call
  `__pageLab.pass`. Site JS can therefore call `__pageLab._set`/`pass` and `__pageLabSignal`
  (`done`, `hand-back`), ending an intervention or the operator's pause on its own. The fix is an
  isolated world (`worldName`) with `pass` reachable only through the CLI; not built, because
  the brief asked for a page function.
- Screenshots include the ~12 % tint.
