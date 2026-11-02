---
name: supervised-driving
description: >
  This skill should be used when an agent drives the operator's own Chromium through the
  chrome-devtools MCP while the operator watches ("drive my browser", "do this in my
  browser while I watch", "fill this form for me", "log in and continue", "I'll do the
  captcha"). It puts a translucent block layer on the page, lets the operator take over
  with Esc, and hands control to the operator for a login, captcha, 2FA or payment step
  and back again, without raising the browser window.
---

# Supervised driving

The operator watches a page the agent drives. The agent never steals their window, never
fights their hands, and never waits to be told it may continue.

Measurements and the reasons behind each rule: `../../references/supervised-driving.md`.
All commands run from the plugin: `node ${CLAUDE_PLUGIN_ROOT}/scripts/supervise.mjs …`
(called `supervise` below).

## 1. Start (once per session)

```bash
supervise start            # detached daemon; overlay ON in every tab, survives navigation
supervise open <url>       # a NEW tab, in the background — see rule 4
```

`start` attaches to the browser on `http://127.0.0.1:9222` (`--browser-url` to change). It
needs the same debug Chromium the `chrome-devtools` MCP uses.

## 2. Drive: arm, then act — every time

The layer swallows ALL pointer and key input, the agent's too, because a CDP click is
indistinguishable from the operator's. So before each action or burst:

```
evaluate_script  () => window.__pageLab.pass(6000)       // opens a 6 s window on THIS tab
click / fill / press_key …                               // lands, inside the window
```

- **Read the result.** `{ok:false,state:"human"}` means the operator has control: **do not act**.
- A burst (several fields) shares one window; keep it short — the operator's input also lands
  while it is open. `pass(6000,{once:true})` shuts on the first click.
- Never send `Escape` under supervision. If you must: `pass(6000,{keys:["Escape"]})`.
- Reading (`take_snapshot`, `evaluate_script`, `take_screenshot`) needs no window.
- `new_page` and `navigate_page` need no window either; the layer re-injects at document-start.

## 3. Operator pressed Esc (state `human`)

Stop acting. Do not re-arm. Block cheaply until they press the **Hand back to Claude** chip:

```bash
supervise wait --timeout 540     # exit 0 = agent again · 20 = still theirs, run it again
supervise state                  # exit 0 agent · 10 human · 11 intervene · 12 daemon down
```

## 4. Need the operator (login, captcha, 2FA, payment)

One call. It drops the layer, shows the reason, notifies with a sound, raises the window
**once**, watches, and returns by itself:

```bash
supervise need-human --reason "Log in to the bank, then I continue" --until 'url:/accounts'
```

`--until`: `url:<regex>` or `sel:<css>` (bare: URL regex if it has `://` or starts with `^`, else
a selector). The operator may instead press **Done** in the banner. On return (exit 0, JSON on
stdout with `resolved: until|done`) the layer is **already back on**: re-check the page, then
carry on. Do not ask the operator to say anything. Exit **20** means they still have control:
run the same command again. Never type into the page during it, and never put a secret value
in `--reason` (it appears in a notification).

## 5. No focus stealing — which tab, and how to get it

Drive the tab the operator is already looking at: any tool call on it is quiet. A **new** tab
the operator must see needs one raise; choose it, do not stumble into it [F-SUPERVISE-FOCUS-TABLE]:

| Goal | Call | Raises the window? |
|---|---|---|
| Work in a tab they do not need to watch | `new_page {background:true}` or `supervise open <url>` | no |
| Show them a new tab | `new_page` (default), or `select_page {bringToFront:true}` | **yes** — switches Space too |
| Anything on an existing page | `pageId` on each tool; `select_page {bringToFront:false}` | no |

A raise is harmless only while Chromium is already frontmost (the operator is watching). Check
first with `supervise state` plus what the operator told you; when unsure, stay in the visible
tab. A background-driven tab still has a live clock, because the MCP turns on focus emulation
for its pages [F-FOCUS-EMULATION].

## 6. Finish

`supervise stop` removes the layer and the injection everywhere. If the daemon dies, every
page hands itself back to the operator within 15 s.
