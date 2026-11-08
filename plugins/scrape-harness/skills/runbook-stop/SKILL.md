---
name: runbook-stop
description: What to do when a scrape-harness CLI run stops or refuses (exit 3-10) — challenge, cooldown, egress, politeness, missing approval. Use whenever a crawl-lists / fetch-ads / ab / crawl resume run exits non-zero, or the run card / live log shows STOPPED.
---

# A run stopped: read the code, then the file, then act

The CLI is the only network gate. A stop is the design working, never a bug to route around.
Files are truth: the run record (`DATA/runs/<run>.json`), its live log (`…log.jsonl`) and
`DATA/events.jsonl` say what happened. Read them before you say anything about the stop.

| Exit | Meaning | Who acts | Next step |
|---|---|---|---|
| 2 | a record failed its schema | agent | fix the source/parser; nothing was written for that batch |
| 3 | networked command without approval flag | operator | ask; never add `--approve-network` yourself |
| 4 | config (DATA/STATE root, pipeline.toml) | agent | fix the env/root; the message names it |
| 5 | **challenge** on one page | operator | `<cli> browser open` (operator, headed), clear once, then `<cli> crawl resume` |
| 6 | **site cooldown** (2 challenges in 1 h) | nobody | wait until the `until` in events.jsonl; only the operator may `cooldown clear` with a reason |
| 7 | politeness ceiling raised without approval | operator | ask; the ceiling stays unless he approves this run |
| 8 | **egress refused** (wrong country, e.g. a VPN) | operator | he fixes the network; re-run the preflight, never bypass it |
| 9 | operator-only action without `--approve-operator` | operator | ask |
| 10 | no matching signed approval for this plan | operator's finger | re-plan with `--plan`; tell the operator a Touch ID prompt is coming, then run `<cli> approve <hash>` — his fingerprint signs it, or nothing is approved |

Every stop opens an INCIDENT (`STATE/ops/incidents.jsonl`; the monitor rings with its id). It stays
open until acked: `<cli> incidents ack <id> --note "<what was done or decided>"` (append-only). Until
then the stopped stage's task is blocked, and the run-steward is not allowed to stop.

Rules:
- Never retry a stopped run in a loop, never switch variant or backend to "get past" a challenge.
- Never clear a cooldown or open the headed browser yourself — the hook asks or blocks.
- `approve` only after telling the operator, never in a loop: a declined Touch ID prompt is a no.
- Report with the run id, the exit code, the reason from events.jsonl and the one next step above.
