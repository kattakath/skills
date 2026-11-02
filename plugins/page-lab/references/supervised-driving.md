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
| `intervene` | off, amber banner with the reason | free | `need-human` | `--until` holds, **Done**, timeout |
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

Verified on `scripts/fixtures/supervise/` with `supervise-selftest.mjs` (35 checks) and, through the
real `chrome-devtools-mcp@1.12.0`, `supervise-measure.mjs`:

| Input | No window | Inside `pass()` |
|---|---|---|
| trusted click (raw CDP, MCP `click`) | swallowed | lands |
| `rawKeyDown`, `Input.insertText` (raw CDP) | swallowed | lands |
| MCP `fill`, `press_key` | swallowed | lands |
| Esc, default window | barge-in | barge-in |

## Intervention (`need-human`)

Layer off, banner with the reason, `osascript` notification with a sound, raise the window
**once**, then poll every 500 ms for `--until` (any tab's URL, or a selector in any tab) or the
Done button; on return the layer is back on. Exit 20 on timeout (default 540 s, under the Bash
tool's 600 s cap) with the banner left up.

- **Raise guard:** a stamp per reason in `$TMPDIR/page-lab-supervise/`, written *before* the
  `activate`, 10 min TTL. A repeat of the same reason notifies again but cannot raise.
  Tested with the osascript calls stubbed (`PAGE_LAB_SUPERVISE_NO_OSASCRIPT=1`).
- **Deliberately not wired: "Esc ends the intervention".** A login modal's Esc is habit; an early
  resume would put the agent's input into the operator's half-typed form. `--esc-ends` opts in,
  and still ignores Esc inside an input.
- `reason` goes into a notification: no secret values.

## Focus stealing — measured

Throwaway-profile Chromium 152 (`open -g -n`), a non-Chromium app frontmost before every probe,
`lsappinfo front` after 900 ms; 3 identical runs [F-SUPERVISE-FOCUS-TABLE].

| Call | Chromium frontmost? |
|---|---|
| MCP `new_page` (default) | **yes — steals** |
| MCP `select_page {bringToFront:true}` | **yes — steals** |
| MCP `list_pages`, `new_page {background:true}`, `navigate_page`, `take_snapshot`, `evaluate_script`, `take_screenshot`, `click`, `fill`, `press_key`, `select_page {bringToFront:false}`, `close_page` | no |
| CDP `Target.createTarget {background:true}`, `Emulation.setFocusEmulationEnabled`, `Input.dispatchMouseEvent` | no |
| CDP `Page.bringToFront` — the positive control | **yes** |

`AppleSpacesSwitchOnActivate` read `1`, so a steal also switches Space when the window is on
another one. The Space switch itself was not observed (one Space under test).

## Not solved, on purpose

- Cross-origin iframes: the layer covers the top frame only.
- Two agents on one browser share one stamp and one state.
- The live notification sound and `activate` were not exercised, to avoid taking the
  operator's focus; their argv and guard were.
- Screenshots include the ~12 % tint.
