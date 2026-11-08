---
name: runbook-approve
description: Get one networked scrape-harness run approved — plan it, warn the operator that a Touch ID prompt is coming, run `<cli> approve <hash>`, and verify the ledger. Use before any crawl-lists / fetch-ads / ab / crawl resume that is not offline, and when a run refused with exit 10.
---

# Approve one exact run (Touch ID is the approval)

The CLI refuses a networked run (exit 10) unless the operator's Secure Enclave key signed an approval
for that EXACT plan (same command, site, backends, rate, pages/ads). The signature is made by
Secretive's agent, so macOS asks for Touch ID; no touch, no approval.

1. **Plan**: `<cli> <command> <args> --plan` → `plan_hash`. Re-plan after ANY argument change: a
   different plan has a different hash, and its approval does not carry over.
2. **Warn first**: tell the operator what will be sent (the run card's Scale and ETA rows, the plan
   summary) and that a Touch ID prompt is coming. Never trigger the prompt unannounced.
3. **Approve**: `<cli> approve <plan_hash> --ttl 30m` (max 24h). A notification shows the summary;
   the operator touches. A declined or timed-out prompt records nothing: that is a NO — never retry.
4. **Verify**: `<cli> approvals verify` → `chain: intact`, `bad_signatures: []`, and the approval
   counted. Then run the command with the same arguments (it consumes the approval once).

Refusals and what they mean:

| Message | Meaning | Action |
|---|---|---|
| `<PREFIX>_APPROVAL_SIGNERS is not set` / not readable | the verifier pin is missing | operator points it at the allowed_signers file (outside any repo) |
| `does not match pipeline.toml [consumer].approval_key_fingerprint` | the pin file and the repo disagree | STOP and report: a pin swap needs both changed |
| `chain is broken` / `not a valid approval.v2` | the ledger was edited | STOP and report; never repair the ledger yourself |
| `expired or already used` | single use, or past its TTL | re-plan and re-approve |
| `no SSH agent socket` | Secretive is not running | ask the operator to start it |
