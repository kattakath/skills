"""CLI contract: exit codes, determinism, run-level dedupe, flags, telemetry."""
import csv
import io
import json
import os
import random
import shutil
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from helpers import ADAPTERS, clean_env, run

TD = ADAPTERS / "td" / "fixtures"
SC = ADAPTERS / "scotiabank" / "fixtures"
OK_FILES = [TD / "clean-chequing.qfx", TD / "multi-account.qfx", TD / "identical-rows.qfx",
            ADAPTERS / "cibc" / "fixtures" / "card-memo-first4.qfx",
            ADAPTERS / "tangerine" / "fixtures" / "posted-fragments.qfx",
            SC / "chequing-regular.layout.txt", SC / "chequing-year-rollover.layout.txt"]


def records(stdout: str) -> list[dict]:
    return [json.loads(line) for line in stdout.splitlines()]


class Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="se-cli-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)


class ExitCodes(Tmp):
    def test_usage(self):
        self.assertEqual(run().returncode, 2)
        self.assertEqual(run("extract").returncode, 2)
        self.assertEqual(run("extract", self.tmp / "missing.qfx").returncode, 2)
        self.assertEqual(run("extract", TD / "clean-chequing.qfx", "--emit-seen").returncode, 2)

    def test_unidentified(self):
        f = self.tmp / "unknown.qfx"
        f.write_bytes((TD / "clean-chequing.qfx").read_bytes().replace(b"<INTU.BID>00002", b"<INTU.BID>09999"))
        p = run("extract", f)
        self.assertEqual((p.returncode, p.stdout), (4, ""))
        self.assertIn("no adapter", p.stderr)

    def test_bad_accounts_file_is_usage(self):
        bad = self.tmp / "a.toml"
        bad.write_text('[[account]]\ninstitution = "TD"\nacctid_last4 = "12"\n')
        self.assertEqual(run("extract", TD / "clean-chequing.qfx", "--accounts", bad).returncode, 2)


class Determinism(unittest.TestCase):
    def test_twice_and_shuffled_argv(self):
        first = run("extract", *OK_FILES)
        self.assertEqual(first.returncode, 0, first.stderr)
        again = run("extract", *OK_FILES)
        shuffled = list(OK_FILES)
        random.Random(7).shuffle(shuffled)
        if shuffled == OK_FILES:
            shuffled.reverse()
        third = run("extract", *shuffled)
        self.assertEqual(first.stdout, again.stdout)
        self.assertEqual(first.stdout, third.stdout)

    def test_no_timestamps_on_stdout(self):
        out = run("extract", *OK_FILES).stdout
        self.assertNotRegex(out, r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}")

    def test_order(self):
        recs = records(run("extract", *OK_FILES).stdout)
        kinds = [r["record"] for r in recs]
        self.assertEqual(kinds, sorted(kinds, key=lambda k: k != "statement"))
        t = [(r["institution"], r["account"], r["booking_date"]) for r in recs
             if r["record"] == "transaction"]
        self.assertEqual(t, sorted(t))
        self.assertTrue(all(r["schema"] == "statement-extract/1" for r in recs))


class RunDedupe(Tmp):
    def test_same_rows_in_two_files_kept_once(self):
        copy = self.tmp / "overlap.qfx"
        copy.write_bytes((TD / "clean-chequing.qfx").read_bytes() + b"\r\n")  # other bytes
        recs = records(run("extract", TD / "clean-chequing.qfx", copy).stdout)
        txns = [r for r in recs if r["record"] == "transaction"]
        self.assertEqual(len(txns), 4)
        self.assertEqual(sum(s["counts"]["dup_in_run"] for s in recs
                             if s["record"] == "statement"), 4)

    def test_collision_is_refused(self):
        other = self.tmp / "collide.qfx"
        other.write_bytes((TD / "clean-chequing.qfx").read_bytes()
                          .replace(b"<TRNAMT>-12.50", b"<TRNAMT>-12.51"))
        p = run("extract", TD / "clean-chequing.qfx", other)
        self.assertEqual((p.returncode, p.stdout), (3, ""))
        self.assertIn("key collision", p.stderr)

    def test_keep_going_partial(self):
        p = run("extract", "--keep-going", TD / "clean-chequing.qfx", TD / "duplicate-fitid.qfx")
        self.assertEqual(p.returncode, 6, p.stderr)
        self.assertEqual(len([r for r in records(p.stdout) if r["record"] == "transaction"]), 4)

    def test_keep_going_all_refused_keeps_the_code(self):
        p = run("extract", "--keep-going", TD / "duplicate-fitid.qfx")
        self.assertEqual((p.returncode, p.stdout), (3, ""))

    def test_seen_and_emit_seen_roundtrip(self):
        seen = self.tmp / "seen.txt"
        acc = SC / "counter-fitid.accounts.toml"
        p1 = run("extract", SC / "counter-fitid.qfx", "--accounts", acc, "--seen", seen,
                 "--emit-seen")
        self.assertEqual(p1.returncode, 0, p1.stderr)
        stored = seen.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(stored), 4)
        self.assertTrue(any("  " in k for k in stored), "a content key with spaces")
        p2 = run("extract", SC / "counter-fitid.qfx", "--accounts", acc, "--seen", seen)
        recs = records(p2.stdout)
        self.assertEqual([r for r in recs if r["record"] == "transaction"], [])
        self.assertEqual(recs[0]["counts"]["seen"], 4)

    def test_manifest_skips_unchanged_unless_forced(self):
        man = self.tmp / "manifest.jsonl"
        f = TD / "clean-chequing.qfx"
        self.assertEqual(len(records(run("extract", f, "--manifest", man).stdout)), 5)
        self.assertEqual(run("extract", f, "--manifest", man).stdout, "")
        self.assertEqual(len(records(run("extract", f, "--manifest", man, "--force").stdout)), 5)


class StderrCarriesNoFigures(unittest.TestCase):
    """Agents verify REAL statements by reading stderr: it must never carry a balance."""

    def test_summary_line_has_no_balance(self):
        p = run("extract", TD / "clean-chequing.qfx")  # closing 1337.50
        self.assertEqual(p.returncode, 0)
        self.assertNotIn("1337.50", p.stderr)
        self.assertIn("structural", p.stderr)

    def test_refusal_names_checks_without_figures(self):
        p = run("extract", TD / "assert-mismatch.qfx",
                "--accounts", TD / "assert-mismatch.accounts.toml")
        self.assertEqual(p.returncode, 3)
        self.assertIn("external_assertion", p.stderr)
        self.assertNotIn("91.00", p.stderr)
        self.assertNotIn("90.00", p.stderr)


class Formats(Tmp):
    def test_csv_and_export_agree(self):
        f = TD / "clean-chequing.qfx"
        direct = run("extract", f, "--format", "csv").stdout
        jl = self.tmp / "out.jsonl"
        jl.write_text(run("extract", f).stdout, encoding="utf-8")
        self.assertEqual(run("export", jl).stdout, direct)
        rows = list(csv.DictReader(io.StringIO(direct)))
        self.assertEqual(len(rows), 4)
        self.assertEqual(rows[0]["key"].split("|")[0], "TD")

    def test_report(self):
        rep = self.tmp / "report.json"
        run("extract", "--keep-going", TD / "clean-chequing.qfx", TD / "no-ledgerbal.qfx",
            "--report", rep)
        doc = json.loads(rep.read_text(encoding="utf-8"))
        self.assertEqual(doc["exit"], 6)
        self.assertEqual(sorted("refusal" in f for f in doc["files"]), [False, True])


class Commands(unittest.TestCase):
    def test_identify(self):
        p = run("identify", TD / "clean-chequing.qfx")
        self.assertEqual(p.returncode, 0)
        self.assertIn("td/qfx", p.stdout)

    def test_print_identifiers_never_account_id(self):
        p = run("identify", "--print-identifiers", TD / "clean-chequing.qfx")
        self.assertEqual(p.returncode, 0)
        self.assertNotIn("00000001101", p.stdout)
        self.assertEqual(set(json.loads(p.stdout)), {"file", "ORG", "FID", "INTU.BID", "CURDEF"})

    def test_explain_is_masked(self):
        p = run("explain", TD / "clean-chequing.qfx")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertNotIn("00000001101", p.stdout)
        self.assertNotIn("0000123456789", p.stdout)
        self.assertEqual(json.loads(p.stdout)["candidates"][0]["adapter"], "td/qfx")

    def test_adapters_and_doctor(self):
        ids = [json.loads(line)["id"] for line in run("adapters").stdout.splitlines()]
        on_disk = sorted(f"{p.parent.name}/{p.stem}" for p in ADAPTERS.glob("*/*.toml"))
        self.assertEqual(ids, on_disk)  # the CLI lists every adapter in the tree, sorted
        self.assertGreaterEqual(len(ids), 6)
        self.assertEqual(run("doctor").returncode, 0)

    def test_fixture_lint_clean(self):
        p = run("fixture", "lint")
        self.assertEqual(p.returncode, 0, p.stdout)


class _Sink(BaseHTTPRequestHandler):
    bodies: list = []

    def do_POST(self):
        n = int(self.headers["Content-Length"])
        _Sink.bodies.append((self.path, self.headers.get("x-team"), self.rfile.read(n)))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *a):
        pass


class Telemetry(Tmp):
    def test_local_log_is_otel_shaped(self):
        log = self.tmp / "runs.jsonl"
        run("extract", TD / "duplicate-fitid.qfx", env=clean_env(STATEMENT_EXTRACT_LOG=str(log)))
        recs = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
        events = [r["Attributes"]["event.name"] for r in recs]
        self.assertEqual(events[0], "run.start")
        self.assertEqual(events[-1], "run.end")
        self.assertIn("refusal", events)
        self.assertEqual(len({r["TraceId"] for r in recs}), 1)
        for r in recs:
            self.assertTrue({"Timestamp", "SeverityText", "SeverityNumber", "Body", "Attributes",
                             "TraceId", "SpanId", "Resource"} <= set(r))
        self.assertNotIn("00000001108", log.read_text(encoding="utf-8"))

    def test_otlp_push_payload(self):
        _Sink.bodies = []
        srv = HTTPServer(("127.0.0.1", 0), _Sink)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        env = clean_env(OTEL_EXPORTER_OTLP_ENDPOINT=f"http://127.0.0.1:{srv.server_port}",
                        OTEL_EXPORTER_OTLP_HEADERS="x-team=ledger",
                        STATEMENT_EXTRACT_LOG=str(self.tmp / "runs.jsonl"))
        self.assertEqual(run("extract", TD / "clean-chequing.qfx", env=env).returncode, 0)
        self.assertEqual(len(_Sink.bodies), 1)
        path, header, body = _Sink.bodies[0]
        self.assertEqual((path, header), ("/v1/logs", "ledger"))
        doc = json.loads(body)
        lr = doc["resourceLogs"][0]["scopeLogs"][0]["logRecords"]
        self.assertTrue(lr[0]["timeUnixNano"].isdigit())
        self.assertEqual(len(lr[0]["traceId"]), 32)
        self.assertIn("stringValue", lr[0]["body"])
        self.assertTrue(all("key" in a and "value" in a for a in lr[0]["attributes"]))

    def test_failed_push_never_fails_extraction(self):
        log = self.tmp / "runs.jsonl"
        env = clean_env(OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:9",
                        STATEMENT_EXTRACT_LOG=str(log))
        p = run("extract", TD / "clean-chequing.qfx", env=env)
        self.assertEqual(p.returncode, 0)
        self.assertIn("telemetry.push_failed", log.read_text(encoding="utf-8"))

    def test_unwritable_log_never_fails_extraction(self):
        env = clean_env(STATEMENT_EXTRACT_LOG="/dev/null/nope/runs.jsonl")
        self.assertEqual(run("extract", TD / "clean-chequing.qfx", env=env).returncode, 0)


if __name__ == "__main__":
    unittest.main()
