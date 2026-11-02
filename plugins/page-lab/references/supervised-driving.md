# Supervised driving — the lock

The agent-facing procedure is `../skills/supervised-driving/SKILL.md`; this file is the evidence
and the limits. Facts are cited by ID and owned by `facts.md`.

## What it is

One injected function, `scripts/lock.js`, run through the `evaluate_script` the agent already has.
No daemon, no stamp or state file, no CDP socket of its own, nothing that outlives the page.

| State | Layer | Operator input | Enters by | Leaves by |
|---|---|---|---|---|
| `locked` | on, ~12 % tint, "press Esc" label | swallowed | `lock()` | `unlock()`, Esc, label click |
| `released` | off | free | Esc or label click | `unlock()` (then `lock()` locks again) |
| none (`__pageLock` absent) | off | free | `unlock()`, or any new document | `lock()` |

- Esc is handled in a window-capture `keydown` listener and releases **before the handler
  returns**, so the layer is gone at once. Esc needs keyboard focus in the page, so clicking the
  label is the second way out.
- A `released` page keeps a stub whose `pass()` answers `{ok:false}`. That is the only signal
  the agent gets that the operator took over, and it only gets it when it next asks.

## Passthrough: `pass(ms)`

CDP `Input.dispatch*` events are `isTrusted:true` and indistinguishable from the operator's
[F-LOCK-TRUSTED-SAME]. So the layer cannot tell the agent's click from a human one, and the
agent opens a short window in which it ignores input: `pointer-events:none` on the layer, and
the capture listeners step aside. The listeners decide at event time, so a throttled timer
cannot leave the window open past `ms`.

**Cooperative, not enforced.** An agent that skips `pass` is swallowed. An operator whose input
arrives inside an open window is not stopped. Esc in a default window unlocks, even when the
agent sent it; `{keys:["Escape"]}` is the opt-out, and only for the agent that asks.

Measured through the real `chrome-devtools-mcp@1.12.0` [F-LOCK-TRUSTED-SAME]:

| Input | No window | Inside `pass()` |
|---|---|---|
| MCP `click` (uid) | swallowed | lands |
| MCP `fill` | swallowed | lands |
| MCP `press_key` | swallowed | lands |
| raw CDP click, `rawKeyDown`, `Input.insertText`, `mouseWheel` | swallowed | lands |
| Esc, default window | unlocks | unlocks |
| Esc, `pass(ms,{keys:["Escape"]})` | unlocks | passes to the page |

One `pass → click → fill → press_key` took about 1.0 s of MCP round trips; model think time is
on top and was not measured, which is why the default window is 5 s, a judgement and not a
measurement.

## Navigation — what survives [F-LOCK-PER-DOCUMENT]

Nothing. The lock is page JS, so every new document starts unlocked. Measured on Chromium 152:

| Way in | New document |
|---|---|
| link click, `Page.navigate`, `navigate_page` | **unlocked**; run `lock` again |
| `Page.addScriptToEvaluateOnNewDocument` holding the lock | locked by load, layer mounted |
| `navigate_page` with `initScript: "(<lock.js>)()"` | locked by load |
| the `navigate_page` after that one | unlocked: puppeteer removes `initScript` when the call returns |

The gap between a navigation and the re-lock is one tool call. During it the page is the
operator's. That is the intended fail-open direction, not a leak to plug with a daemon.

## Not solved, on purpose

- **Cross-origin iframes** (not tested): the layer sits above them in the top frame, so the pointer
  hit-tests to it, but a key typed into a focused out-of-process frame never reaches the top-level
  listeners.
- **Main-world exposure.** The lock runs in the page's world so `evaluate_script` can call
  `__pageLock.pass`. Site JS can call `__pageLock.unlock()` or `pass()` too. It would take an
  isolated world to prevent it; nobody asked.
- **A page that removes the layer node** (not tested; read from the code): the tint and label go,
  but the window-capture listeners stay, so input is still swallowed and Esc still works.
- **A lock nobody removes.** If the agent dies mid-task, the lock stays until Esc, the label
  click, or a navigation. There is no timeout by design.
- Screenshots include the ~12 % tint.
- Tab visibility, focus and raising the window are outside this feature. The lock never raises
  Chromium and never notifies.
