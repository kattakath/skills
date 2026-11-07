# brain-signals

An answer-shape kit: verdict first, then layered detail, easy to scan, with real ASCII diagrams.

| Component | What it does |
|---|---|
| Output style `brain-signals:Brain Signals` | The shape itself. Select it with `/config`, or with `"outputStyle": "brain-signals:Brain Signals"` in settings. |
| `/explain`, `/compare`, `/map`, `/zoom`, `/why`, `/tldr`, `/diagram` | The same shape, one command per kind of question. |
| `cartographer` agent | A read-only architecture explainer that draws ASCII diagrams. |
| `/task` | Goal-locked execution: an approved contract, a frozen todo list, and a parking lot for anything off-plan. |
| Stop hook `stop-limbo` | Warns when a turn ends in limbo. **Warn only, never blocks.** |

`/diagram` and `cartographer` render with the [`mermaid-ascii`](https://github.com/AlexanderGrooff/mermaid-ascii) CLI, which you need on `PATH`.

## The `stop-limbo` Stop hook

It fixes one problem: a reply ends and you cannot tell if Claude is waiting on something or waiting on you.

| Case | Fires when |
|---|---|
| `open-question` | The reply's last paragraph ends in `?` or is a prose offer ("want me to", "let me know", "should I", "say the word"…), and no `AskUserQuestion` call came after it. A decision should be click-to-select options, not a question you must type an answer to. |
| `silent-wait` | Background work is still running and the reply never says it is waiting ("waiting", "watch", "background", "I'll report", "resume", "notified", `⏳`…). |

### What it reads

- **`last_assistant_message`** and **`background_tasks`** from the Stop hook input ([hooks reference](https://code.claude.com/docs/en/hooks), "Stop input"). Verified on Claude Code 2.1.300.
- **The transcript's last 1 MiB**, only to see whether `AskUserQuestion` followed the text. It is also the fallback on a CLI that does not send those two fields.
- In the fallback, a background launch counts as running until a `<task-notification>` reports it terminal or `TaskStop` stops it. A launch older than the 1 MiB window is not seen.

### What it does not do

- **It never blocks.** The output is `{"systemMessage": "…"}`, shown to you and nothing else. On Stop, both `decision: "block"` and `additionalContext` would continue the turn, so it uses neither.
- **It fails open.** Bad input, or a transcript it cannot read, means no output and exit 0.
- It skips a turn that a Stop hook already continued (`stop_hook_active`).

### Reading the log

Each warning appends one JSON line to `stop-limbo.jsonl`, with `ts`, `case` and `session_id` only. No reply text is logged. The file is in `$CLAUDE_PLUGIN_DATA`, falling back to `$XDG_STATE_HOME/brain-signals/` and then `~/.local/state/brain-signals/`.

```bash
f="${CLAUDE_PLUGIN_DATA:-${XDG_STATE_HOME:-$HOME/.local/state}/brain-signals}/stop-limbo.jsonl"
jq -r .case "$f" | sort | uniq -c    # warnings per case
```

### Block mode comes later

Block mode is a separate decision. First, count the false positives from this log against the sessions it names.

**Known false-positive shapes:**
- A rhetorical `?` in a closing line.
- An offer phrase quoted in the last paragraph.
- A long-lived background task, such as a `Monitor`, that every reply would otherwise have to mention.

**Known misses:** a wait word used for another reason ("watch out", "a background note") silences `silent-wait`.
