---
name: supervised-driving
description: >
  This skill should be used when an agent drives the operator's own Chromium through the
  chrome-devtools MCP while the operator is watching ("drive my browser", "do this in my
  browser", "fill this form for me", "log in and continue"). It locks the operator out with a
  translucent layer while the agent works, ends the lock when the agent is done or the operator
  presses Esc, and otherwise stays out of the way: an unlocked browser is the operator's turn.
---

# Supervised driving

Three rules. The operator wrote them; do not add to them.

1. **While you drive, the operator is locked out.** A translucent layer ("Claude is driving —
   press Esc to take over") swallows their mouse, wheel and keyboard.
2. **The lock ends when you are done, or when they press Esc.** Esc removes it at once.
3. **Nothing else.** No hand-back, no banner, no notification, no sound, no raising the window,
   no watching. An unlocked browser is the operator's turn; they will prompt you in chat.

The lock is `${CLAUDE_PLUGIN_ROOT}/scripts/lock.js`: one arrow function. Pass its whole text as
`evaluate_script`'s `function`. Measurements and limits: `../../references/supervised-driving.md`.

## Use

```
1. lock    evaluate_script  function = <contents of lock.js>        -> "locked"
2. act     evaluate_script  () => __pageLock.pass(5000)             -> {ok:true}
           click / fill / press_key / ...                           (lands, inside the window)
3. unlock  evaluate_script  () => __pageLock.unlock()               -> "unlocked"
```

- **Lock first, then act.** The layer swallows the agent's input too: a CDP click is
  indistinguishable from the operator's. So before each action or burst, open a short window
  with `pass(ms)` (default 5000, max 30000). Several fields in a row share one window. Keep it
  short: the operator's input also lands while it is open.
- **Read the `pass` result.** `{ok:false, state:"released"}` means the operator pressed Esc.
  **Stop acting**, call `unlock()`, and tell them you stopped. Do not lock again until they ask.
- **Reading needs no window**: `take_snapshot`, `take_screenshot`, `evaluate_script`.
- **Always `unlock()` when the task is done**, including on an error path. A lock left behind
  holds the operator out until they press Esc.
- **Do not send `Escape` while locked**: it unlocks, exactly like theirs. If a page needs one,
  `__pageLock.pass(5000, {keys:["Escape"]})` lets yours through without unlocking.

## Navigation drops the lock

The lock lives in one document. A navigation, from `navigate_page` or from a click on a link,
loads a fresh document with **no lock**. After anything that may navigate, run step 1 again; it
is idempotent. To have the new document locked from its first moment, pass the same text to
`navigate_page` as `initScript` wrapped as a call: `initScript = "(<contents of lock.js>)()"`.
`initScript` covers that one navigation only.

If the operator pressed Esc, a repeat `lock()` on that page answers `"released"` and does **not**
lock again. Only `unlock()` followed by `lock()` does.
