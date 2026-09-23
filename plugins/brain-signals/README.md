# brain-signals

An answer-shape kit: verdict first, then layered detail, easy to scan, with real ASCII diagrams.

| Component | What it does |
|---|---|
| Output style `brain-signals:Brain Signals` | The shape itself. Select it with `/config`, or with `"outputStyle": "brain-signals:Brain Signals"` in settings. |
| `/explain`, `/compare`, `/map`, `/zoom`, `/why`, `/tldr`, `/diagram` | The same shape, one command per kind of question. |
| `cartographer` agent | A read-only architecture explainer that draws ASCII diagrams. |
| `/task` | Goal-locked execution: an approved contract, a frozen todo list, and a parking lot for anything off-plan. |

`/diagram` and `cartographer` render with the [`mermaid-ascii`](https://github.com/AlexanderGrooff/mermaid-ascii) CLI, which you need on `PATH`.
