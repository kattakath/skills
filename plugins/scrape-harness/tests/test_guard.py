"""Hook cases for the agent contracts and the SessionStart status, driven as Claude Code drives them:
JSON on stdin, exit code + stderr/stdout out. Stdlib only. The consumer is synthetic (fixtures/pipeline.toml)
and its CLI is fixtures/stubcli, which reproduces the real `validate` outcomes (see its docstring); the
harness's own suite drives the same gates against the real CLI."""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN = HERE.parent
GUARD = PLUGIN / "hooks" / "guard.py"
FIXTURES = HERE / "fixtures"
INC = "INC-20260116T060500Z-a1b2c3"

REPORT = {
    "schema": "run_report.v1",
    "run_ids": ["2026-01-16T06:00:00Z-crawl-lists"],
    "state": "stopped",
    "exit_code": 5,
    "stop_reason": "challenge: an interstitial on list page 2",
    "counts": {"list_pages": 2, "challenges": 1},
    "open_incidents": [INC],
    "next_action": "operator_clear_gate",
    "evidence": ["DATA:runs/2026-01-16t06-00-00z-crawl-lists.json"],
}
DIAGNOSIS = {
    "schema": "diagnosis.v1",
    "symptom": "reparse wrote listings with no price",
    "root_cause": "the price selector matches an old class",
    "evidence": [{"file": "src/source.py", "line": 4, "quote": "price = card.select_one('.old')"}],
    "fix": {"change": "read the new class", "files": ["src/source.py"]},
    "tests": ["test_price_is_read_from_the_new_class"],
    "confidence": "high",
    "blocked_on": None,
}


class Hook(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="sh-guard-"))
        self.state = self.tmp / "state"
        self.env = {
            "PATH": f"{FIXTURES}:{os.environ.get('PATH', '')}",
            "HOME": str(self.tmp),
            "CLAUDE_PROJECT_DIR": str(self.tmp),
            "SCRAPE_HARNESS_PIPELINE": str(FIXTURES / "pipeline.toml"),
            "STUB_STATE": str(self.state),
        }

    def run_gate(self, gate, payload, **env):
        return subprocess.run(
            [sys.executable, "-I", str(GUARD), gate],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            env={**self.env, **env},
            timeout=60,
        )

    def open_incident(self, iid=INC, kind="challenge", code=5, run="run-1", stage="crawl-lists"):
        f = self.state / "ops" / "incidents.jsonl"
        f.parent.mkdir(parents=True, exist_ok=True)
        rec = {"schema": "incident.v1", "id": iid, "event": "opened", "at": "2026-01-16T06:05:00Z",
               "kind": kind, "code": code, "run_id": run, "stage": stage,
               "reason": "STOPPED: challenge at https://www.example.invalid/listings/p2"}  # fmt: skip
        with f.open("a") as fh:
            fh.write(json.dumps(rec) + "\n")

    def stop(self, agent, message, active=False):
        return {"hook_event_name": "SubagentStop", "agent_type": f"scrape-harness:{agent}",
                "stop_hook_active": active, "last_assistant_message": message}  # fmt: skip


class Contracts(Hook):
    """run-steward -> run_report.v1, pipeline-engineer -> diagnosis.v1 (analyst stays finding.v1)."""

    CASES = (("steward", "run-steward", REPORT, "run_report.v1"),
             ("engineer", "pipeline-engineer", DIAGNOSIS, "diagnosis.v1"))  # fmt: skip

    def test_a_valid_object_may_stop(self):
        for gate, agent, obj, _ in self.CASES:
            r = self.run_gate(gate, self.stop(agent, json.dumps(obj)))
            self.assertEqual(r.returncode, 0, (gate, r.stderr))
            fenced = self.run_gate(gate, self.stop(agent, f"```json\n{json.dumps(obj)}\n```"))
            self.assertEqual(fenced.returncode, 0, (gate, fenced.stderr))

    def test_an_invalid_object_blocks_naming_the_schema(self):
        for gate, agent, obj, contract in self.CASES:
            r = self.run_gate(gate, self.stop(agent, json.dumps({**obj, "invalid": True})))
            self.assertEqual(r.returncode, 2, gate)
            self.assertIn(contract, r.stderr)
            self.assertIn(f"schemas/{contract}.schema.json", r.stderr)
            self.assertIn("ONLY the corrected JSON object", r.stderr)

    def test_prose_blocks(self):
        for gate, agent, _, contract in self.CASES:
            r = self.run_gate(gate, self.stop(agent, "All good, the run finished."))
            self.assertEqual(r.returncode, 2, gate)
            self.assertIn(contract, r.stderr)
            empty = self.run_gate(gate, self.stop(agent, ""))
            self.assertEqual(empty.returncode, 2, gate)
            self.assertIn(contract, empty.stderr)

    def test_one_retry_then_it_may_stop(self):
        for gate, agent, _, contract in self.CASES:
            r = self.run_gate(gate, self.stop(agent, "still prose", active=True))
            self.assertEqual(r.returncode, 0, gate)
            self.assertIn(contract, r.stderr)

    def test_an_older_harness_that_lacks_the_contract_allows_with_one_line(self):
        """Version skew: the plugin auto-updated, the consumer's harness is pinned older."""
        for gate, agent, obj, contract in self.CASES:
            r = self.run_gate(gate, self.stop(agent, json.dumps({**obj, "invalid": True})), STUB_KNOWN="finding.v1")
            self.assertEqual(r.returncode, 0, (gate, r.stderr))
            msg = json.loads(r.stdout)["systemMessage"]
            self.assertEqual(msg.count("\n"), 0)
            self.assertIn(contract, msg)
            self.assertIn("nix flake update scrape-harness", msg)

    def test_an_unknown_name_that_is_another_contract_still_blocks(self):
        """Only `unknown contract '<this contract>'` counts as skew; any other exit-1 failure blocks."""
        r = self.run_gate(
            "engineer", self.stop("pipeline-engineer", "not json"), STUB_KNOWN="finding.v1,diagnosis.v1"
        )
        self.assertEqual(r.returncode, 2)

    def test_the_analyst_gate_is_unchanged(self):
        bad = self.run_gate("subagent", self.stop("analyst", "I think H1 holds."))
        self.assertEqual(bad.returncode, 2)
        self.assertIn("finding.v1", bad.stderr)


class Steward(Hook):
    """Both apply: an unacked incident keeps it working, and its answer must be a run_report.v1."""

    def test_an_open_incident_blocks_even_a_valid_report_and_even_on_retry(self):
        self.open_incident()
        for active in (False, True):
            r = self.run_gate("steward", self.stop("run-steward", json.dumps(REPORT), active=active))
            self.assertEqual(r.returncode, 2)
            self.assertIn(INC, r.stderr)
            self.assertIn("incidents ack", r.stderr)

    def test_an_open_incident_and_an_invalid_report_name_both(self):
        self.open_incident()
        r = self.run_gate("steward", self.stop("run-steward", "prose"))
        self.assertEqual(r.returncode, 2)
        self.assertIn(INC, r.stderr)
        self.assertIn("run_report.v1", r.stderr)

    def test_an_acked_incident_releases_it(self):
        self.open_incident()
        with (self.state / "ops" / "incidents.jsonl").open("a") as fh:
            fh.write(json.dumps({"schema": "incident.v1", "id": INC, "event": "acked", "by": "agent", "note": "reported"}) + "\n")
        r = self.run_gate("steward", self.stop("run-steward", json.dumps(REPORT)))
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_the_teammate_hold_needs_no_message(self):
        idle = {"hook_event_name": "TeammateIdle", "teammate_name": "run-steward"}
        self.assertEqual(self.run_gate("teammate", idle).returncode, 0)
        self.open_incident()
        r = self.run_gate("teammate", idle)
        self.assertEqual(r.returncode, 2)
        self.assertIn(INC, r.stderr)
        other = self.run_gate("teammate", {**idle, "teammate_name": "someone-else"})
        self.assertEqual(other.returncode, 0)


class Wiring(unittest.TestCase):
    def test_hooks_json_gates_each_contracted_agent(self):
        subs = json.loads((PLUGIN / "hooks" / "hooks.json").read_text())["hooks"]["SubagentStop"]
        by = {s["matcher"]: s["hooks"][0] for s in subs}
        self.assertEqual(
            {m: h["command"].rsplit(" ", 1)[1] for m, h in by.items()},
            {"^scrape-harness:analyst$": "subagent", "^scrape-harness:run-steward$": "steward",
             "^scrape-harness:pipeline-engineer$": "engineer"},
        )  # fmt: skip
        for h in by.values():
            self.assertGreaterEqual(h.get("timeout", 0), 120)  # the CLI may be reached through `nix run`

    def test_each_contracted_agent_ends_with_a_return_section_and_a_valid_example(self):
        for agent, contract in (("run-steward", "run_report.v1"), ("pipeline-engineer", "diagnosis.v1"),
                                ("analyst", "finding.v1")):  # fmt: skip
            text = (PLUGIN / "agents" / f"{agent}.md").read_text()
            if agent == "analyst":
                self.assertIn(contract, text)
                continue
            tail = text.split("\n## Return\n", 1)
            self.assertEqual(len(tail), 2, f"{agent}: no final `## Return` section")
            self.assertNotIn("\n## ", tail[1], f"{agent}: `## Return` is not the last section")
            self.assertIn(f"schemas/{contract}.schema.json", tail[1])
            (example,) = re.findall(r"```json\n(.*?)\n```", tail[1], re.S)
            self.assertEqual(json.loads(example)["schema"], contract)


class SessionStatus(Hook):
    def context(self, **env):
        r = self.run_gate("session", {"hook_event_name": "SessionStart", "source": "startup"}, **env)
        self.assertEqual(r.returncode, 0, r.stderr)
        ctx = json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"]
        head, seed = ctx.split("\n", 1)
        self.assertEqual(json.loads(seed)[0]["subject"], "Stage 1/2: crawl-lists")  # the seed still parses
        return head

    def write_status(self, **over):
        st = {"schema": "status.v1", "run_id": "2026-01-16T06:00:00Z-crawl-lists-desktop-abc123",
              "command": "crawl-lists", "stage": "1/2", "status": "stopped", "created_at": "2026-01-16T06:00:00Z",
              "updated_at": "2026-01-16T06:04:00Z", "pid": 4242, "requests": {"list_pages": 2, "robots": 1},
              "planned": 10, "per_minute": 7, "challenges": 1, "log": "/private/DATA/runs/x.log.jsonl"}  # fmt: skip
        self.state.mkdir(parents=True, exist_ok=True)
        (self.state / "status.json").write_text(json.dumps({**st, **over}))

    def test_the_last_run_and_open_incidents_are_summarised(self):
        self.write_status()
        self.open_incident()
        self.open_incident("INC-20260116T070000Z-d4e5f6", kind="cooldown", code=6, stage="crawl-lists")
        head = self.context()
        self.assertIn("2026-01-16T06:00:00Z-crawl-lists-desktop-abc123", head)
        self.assertIn("stopped", head)
        self.assertIn(INC, head)
        self.assertIn("INC-20260116T070000Z-d4e5f6", head)
        self.assertIn("exit 6", head)
        self.assertIn("cooldown", head)

    def test_no_run_yet_is_said(self):
        self.assertIn("no run recorded", self.context())

    def test_bounded_and_value_free(self):
        data = str(self.tmp / "drive" / "DATA")
        self.write_status(run_id="r" * 5000, command="crawl-lists /etc/passwd", status="x\ny" * 400)
        for i in range(60):
            self.open_incident(f"INC-20260116T0700{i:02d}Z-abcdef")
        head = self.context(STUB_DATA=data, STUB_KEY="sekrit-value-123")
        status = head.split("Status now: ", 1)[1]
        self.assertLessEqual(len(status), 1500)
        for leak in ("sekrit-value-123", data, str(self.state), "/private/DATA", "/etc/passwd", "example.invalid"):
            self.assertNotIn(leak, head)
        self.assertNotIn("\n", head)

    def test_an_unreadable_status_fails_open(self):
        self.state.mkdir(parents=True)
        (self.state / "status.json").write_text("{not json")
        self.assertIn("no run recorded", self.context())


if __name__ == "__main__":
    unittest.main()
