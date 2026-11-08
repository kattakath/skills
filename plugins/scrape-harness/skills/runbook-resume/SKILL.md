---
name: runbook-resume
description: Continue a stopped scrape-harness run from its persisted queue with `<cli> crawl resume` — after a challenge was cleared, a cooldown ended or the network was fixed — without re-sending a single finished request. Use when a run's status is "stopped" and the cause is gone.
---

# Resume a stopped run (no duplicate GETs)

A stopped run keeps its crawlee request queue in `STATE/crawlee/request_queues/<queue>`; finished
requests are not in it any more, so a resume sends only what was left.

1. **Read why it stopped** (`DATA/runs/<run>.json` status + `DATA/events.jsonl`; the `runbook-stop`
   skill maps the exit code). Resume only when that cause is gone:
   - challenge (exit 5): the operator cleared it in `<cli> browser open`;
   - cooldown (exit 6): `<cli> cooldown status` shows none active for the site (never clear it yourself);
   - egress (exit 8): the operator fixed the network (a resume re-runs the preflight).
2. **Plan it**: `<cli> crawl resume [--run-id <run>] --plan` — nothing is sent; note the plan hash.
3. **Approve it** with the `runbook-approve` skill (a resume is networked like the run it continues).
4. **Run it**: `<cli> crawl resume [--run-id <run>]`. The request counts ADD to the run record's.
5. **Report**: the run id, requests sent by kind (run record `requests`), the new status, and — if it
   stopped again — the new reason. Two stops on the same site within an hour is a cooldown: stop there.

Never start a NEW run to "get around" a stopped one: the queue would refetch pages already viewed.
