# brain-signals

An answer-shape kit: verdict first, then layered detail, easy to scan, with real ASCII diagrams.

| Component | What it does |
|---|---|
| Output style `brain-signals:Brain Signals` | The shape itself. Select it with `/config`, or with `"outputStyle": "brain-signals:Brain Signals"` in settings. |
| `/explain`, `/compare`, `/map`, `/zoom`, `/why`, `/tldr`, `/diagram` | The same shape, one command per kind of question. |
| `cartographer` agent | A read-only architecture explainer that draws ASCII diagrams. |
| `/task` | Goal-locked execution: an approved contract, a frozen todo list, and a parking lot for anything off-plan. |
| Stop hook `stop-limbo` | Warns when a turn ends in limbo. **Warn only, never blocks.** |

`/diagram` and `cartographer` render with the [`mermaid-ascii`](https://github.com/AlexanderGrooff/mermaid-ascii) CLI, which you need on `PATH`. It is not bundled: a plugin `bin/` directory would stop claude.ai and Cowork installing this plugin. If it is missing, a SessionStart hook says so once (with install options) and tells Claude to hand-draw diagrams instead.

**Node.js on `PATH`.** Both hooks (`stop-limbo`, the mermaid-ascii hint) run with `node`, and the Claude Code CLI is a native binary that does not ship one. Without it they cannot start; the output style, commands and agent still work. The superhook plugin, if installed, says so at session start. The hook scripts import nothing at run time. CI type-checks them (`tsc --checkJs`, `tsconfig.hooks.json` at the repo root) against the hook input and output types in Anthropic's `@anthropic-ai/claude-agent-sdk`; those types exist only in JSDoc comments.

The style's rules are accessibility rules backed by published standards and measured effect sizes, not taste: [answer-shape evidence](https://github.com/kattakath/nix-config/blob/main/docs/answer-shape-evidence.md).

### Two traps the files guard against

- **Diagram width.** Measure with `LC_ALL=C.UTF-8 wc -mL` (the last number is the width). Measured 2026-11-07 on a 10-column diagram: BSD (macOS) `wc -L` reports **30**, because it counts bytes. GNU `wc -L` reports **9** without a UTF-8 locale.
- **Plugin agent names.** `/map` forks into `cartographer`, which this plugin registers as `brain-signals:cartographer`. With a bare `agent: cartographer`, the 1.1.2 skill ran on `general-purpose` instead, and nothing reported an error.

`tests/shape-cases.sh` pins both traps. It also pins the frontmatter keys Claude Code honours, which matters because it ignores an unknown key silently.

## The `stop-limbo` Stop hook

It fixes one problem: a reply ends and you cannot tell if Claude is waiting on something or waiting on you.

| Case | Fires when |
|---|---|
| `open-question` | The reply's last paragraph ends in `?` or is a prose offer ("want me to", "let me know", "should I", "say the word"…), and no `AskUserQuestion` call came after it. A decision should be click-to-select options, not a question you must type an answer to. |
| `silent-wait` | Background work is still running and the reply never says it is waiting ("waiting", "watch", "background", "I'll report", "resume", "notified", "still working", "in progress", `⏳`…). |

**Not counted as in flight:** teammates, a `paused` task (nothing is moving), and a deliberate daemon whose description carries `[daemon]` (an SSM tunnel, a log tail). Launch a session-long background loop with `[daemon]` in its description, or every reply that does not mention it warns.

### What it reads

- **`last_assistant_message`** and **`background_tasks`** from the Stop hook input ([hooks reference](https://code.claude.com/docs/en/hooks), "Stop input"). Verified on Claude Code 2.1.300.
- **The transcript's last 1 MiB**, only to see whether `AskUserQuestion` followed the text. It is also the fallback on a CLI that does not send those two fields.
- In the fallback, a background launch counts as running until a `<task-notification>` reports it terminal or `TaskStop` stops it. A launch older than the 1 MiB window is not seen.

### What it does not do

- **It never blocks.** The output is `{"systemMessage": "…"}`, shown to you and nothing else. On Stop, both `decision: "block"` and `additionalContext` would continue the turn, so it uses neither.
- **It fails open.** Bad input, or a transcript it cannot read, means no output and exit 0.
- It skips a turn that a Stop hook already continued (`stop_hook_active`).

### Reading the log

Each warning appends one JSON line to `stop-limbo.jsonl`, with `ts`, `case` and `session_id`. A `silent-wait` line also lists the `tasks` it counted (type, status, the first 80 characters of the description), so a false positive can be traced to its cause. No reply text is logged. The file is in `$CLAUDE_PLUGIN_DATA`, falling back to `$XDG_STATE_HOME/brain-signals/` and then `~/.local/state/brain-signals/`.

```bash
f="${CLAUDE_PLUGIN_DATA:-${XDG_STATE_HOME:-$HOME/.local/state}/brain-signals}/stop-limbo.jsonl"
jq -r .case "$f" | sort | uniq -c    # warnings per case
```

### Block mode comes later

Block mode is a separate decision. First, count the false positives from this log against the sessions it names.

Measured 2026-11-07 by replaying 465 completed turns from 40 real sessions: `open-question` fired on 47 (10%). Most matched "say the word" (18) or "want me to" (20), the prose offers it targets.

**Known false-positive shapes:**
- A rhetorical `?` in a closing line.
- An offer phrase quoted in the last paragraph, such as a `>` blockquote.
- A long-lived background task, such as a `Monitor`, that every reply would otherwise have to mention. `background_tasks` also lists ambient watchers ([anthropics/claude-code#98816](https://github.com/anthropics/claude-code/issues/98816)).

**Fixed in 1.1.3, each pinned by a case:** a `?` inside inline code (`` `foo?` ``) no longer fires. A typographic `I’ll report` or "notification" now counts as a wait line. A question followed by a trailing `---` rule is no longer missed.

**Known misses:**
- A wait word used for another reason ("watch out", "a background note", "resume" as in a CV) silences `silent-wait`.
- Agent Teams teammates never count as background work: they live for the whole session.
- A reply that a blocking Stop hook forced (`stop_hook_active` is true) is never checked, even though it is the one you read.
