"""Position records: loan and mortgage balance snapshots (opt-in, additive within /1)."""
import csv
import hashlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from helpers import ADAPTERS, cases, run
from statement_extract import engine, registry

CIBC = ADAPTERS / "cibc" / "fixtures" / "mortgage-details-regular.layout.txt"
BMO = ADAPTERS / "bmo" / "fixtures" / "mortgage-details-regular.layout.txt"
TD = ADAPTERS / "td" / "fixtures" / "mortgage-statement-regular.layout.txt"
NSLSC = ADAPTERS / "nslsc" / "fixtures" / "loan-statement-regular.layout.txt"
CHEQUING = ADAPTERS / "cibc" / "fixtures" / "chequing-pdf-regular.layout.txt"
POSITION_ADAPTERS = {"cibc/mortgage-details", "bmo/mortgage-details", "td/mortgage-statement",
                     "nslsc/loan-statement"}
RECORD_KEYS = {"schema", "record", "position_id", "institution", "account", "as_of",
               "as_of_basis", "balances", "terms", "source", "reconcile"}


def records(stdout: str) -> list[dict]:
    return [json.loads(line) for line in stdout.splitlines()]


def positions(stdout: str) -> list[dict]:
    return [r for r in records(stdout) if r["record"] == "position"]


class Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="se-pos-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def copy(self, src: Path, name: str, transform=lambda t: t) -> Path:
        dst = self.tmp / name
        dst.write_text(transform(src.read_text(encoding="utf-8")), encoding="utf-8")
        return dst


class Shape(unittest.TestCase):
    def test_record_shape(self):
        p = run("extract", CIBC)
        self.assertEqual(p.returncode, 0, p.stderr)
        (rec,) = records(p.stdout)
        self.assertEqual(set(rec), RECORD_KEYS)
        self.assertEqual((rec["schema"], rec["record"]), ("statement-extract/1", "position"))
        self.assertEqual(rec["account"], {"ref": "••3456", "kind": "mortgage", "currency": "CAD"})
        self.assertEqual((rec["as_of"], rec["as_of_basis"]), ("2022-04-01", "last_payment_date"))
        self.assertEqual(rec["balances"], {"principal_outstanding": "245678.90"})
        self.assertEqual(rec["terms"]["rate"], "2.45")
        self.assertEqual(rec["terms"]["remaining_amortization"], "P23Y4M")
        self.assertTrue(all(isinstance(v, str) for v in rec["terms"].values()))
        self.assertEqual(set(rec["source"]), {"file", "sha256", "format", "extractor_version",
                                              "adapter", "repairs", "text_backend"})
        self.assertEqual(rec["reconcile"]["status"], "structural")

    def test_position_id_is_institution_ref_kind_as_of(self):
        rec = positions(run("extract", TD).stdout)[0]
        want = hashlib.sha256("TD|••0123|mortgage|2020-12-31".encode()).hexdigest()[:16]
        self.assertEqual(rec["position_id"], want)
        self.assertEqual(engine.position_id("TD", "••0123", "mortgage", "2020-12-31"), want)

    def test_a_snapshot_is_never_proven(self):
        # NSLSC's statement is proven; its position from the same file stays structural.
        recs = records(run("extract", NSLSC).stdout)
        self.assertEqual({r["record"]: r["reconcile"]["status"] for r in recs
                          if r["record"] != "transaction"},
                         {"statement": "proven", "position": "structural"})
        p = run("extract", CIBC, "--require", "proven")
        self.assertEqual((p.returncode, p.stdout), (3, ""))
        self.assertIn("never proven", p.stderr)

    def test_stderr_carries_counts_not_figures(self):
        p = run("extract", TD)
        self.assertIn("position (mortgage): 6 balances, 10 terms", p.stderr)
        for figure in ("287654.32", "287,654.32", "2.79", "1134.68"):
            self.assertNotIn(figure, p.stderr)


class Determinism(Tmp):
    def test_same_id_from_a_differently_named_reworded_copy(self):
        other = self.copy(CIBC, "renamed.layout.txt", lambda t: t + "\n\n")
        a, b = positions(run("extract", CIBC).stdout), positions(run("extract", other).stdout)
        self.assertNotEqual(a[0]["source"]["sha256"], b[0]["source"]["sha256"])
        self.assertEqual(a[0]["position_id"], b[0]["position_id"])

    def test_twice_and_reversed_argv(self):
        files = [CHEQUING, NSLSC, TD, BMO, CIBC]
        first = run("extract", *files)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertTrue(first.stdout)
        self.assertEqual(first.stdout, run("extract", *files).stdout)
        self.assertEqual(first.stdout, run("extract", *reversed(files)).stdout)


class Dedupe(Tmp):
    def test_same_snapshot_from_two_files_is_kept_once(self):
        other = self.copy(CIBC, "second-copy.layout.txt", lambda t: t + "\n")
        p = run("extract", CIBC, other)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(len(positions(p.stdout)), 1)

    def test_byte_identical_copy_is_kept_once(self):
        other = self.tmp / "identical.layout.txt"
        other.write_bytes(TD.read_bytes())
        self.assertEqual(len(positions(run("extract", TD, other).stdout)), 1)

    def test_same_id_different_payload_is_refused(self):
        # A different balance on the same account and as_of, with the page's own arithmetic
        # still tying (both printed copies of the balance changed): two files disagree.
        other = self.copy(CIBC, "disagree.layout.txt",
                          lambda t: t.replace("$245,678.90", "$245,678.91"))
        self.assertEqual(run("extract", other).returncode, 0)
        p = run("extract", CIBC, other)
        self.assertEqual((p.returncode, p.stdout), (3, ""))
        self.assertIn("position_collision", p.stderr)
        self.assertNotIn("245678", p.stderr)


class Order(unittest.TestCase):
    def test_statements_then_positions_then_transactions(self):
        recs = records(run("extract", TD, CHEQUING, NSLSC, BMO, CIBC).stdout)
        kinds = [r["record"] for r in recs]
        rank = {"statement": 0, "position": 1, "transaction": 2}
        self.assertEqual(kinds, sorted(kinds, key=rank.get))
        self.assertEqual(kinds.count("position"), 4)
        pos = [(r["institution"], r["account"]["ref"], r["as_of"]) for r in recs
               if r["record"] == "position"]
        self.assertEqual(pos, sorted(pos))


class Csv(Tmp):
    def test_positions_are_skipped_in_the_transactions_csv(self):
        p = run("extract", NSLSC, TD, "--format", "csv")
        self.assertEqual(p.returncode, 0, p.stderr)
        rows = list(csv.DictReader(io.StringIO(p.stdout)))
        self.assertEqual(len(rows), 12)  # NSLSC's 12 rows; no position, no statement
        jsonl = self.tmp / "out.jsonl"
        jsonl.write_text(run("extract", NSLSC, TD).stdout, encoding="utf-8")
        self.assertEqual(run("export", jsonl).stdout, p.stdout)


class LeakGate(unittest.TestCase):
    def _pos(self, **over) -> dict:
        rec = positions(run("extract", CIBC).stdout)[0]
        rec.update(over)
        return rec

    def test_position_id_is_exempt_like_statement_id(self):
        self.assertEqual(engine.leak_scan([self._pos(position_id="1234567890abcdef")]), [])

    def test_balances_and_terms_are_gated(self):
        rec = self._pos()
        rec["terms"]["note"] = "ref 12345678"
        self.assertEqual(engine.leak_scan([rec]), ["position#0 terms.note"])


class Guard(unittest.TestCase):
    """one_source_per_period and the statement chain read statements only."""

    def _result(self, adapter_id: str, as_of: str) -> engine.FileResult:
        r = engine.FileResult(Path("x"), "0" * 64)
        r.positions.append({"institution": "CIBC", "account": {"ref": "••1234"},
                            "as_of": as_of, "period": {"start": as_of, "end": as_of},
                            "source": {"adapter": {"id": adapter_id}}})
        return r

    def test_positions_from_two_adapters_on_one_day_do_not_trip_it(self):
        results = [self._result("cibc/mortgage-details", "2025-10-15"),
                   self._result("cibc/chequing-pdf", "2025-10-15")]
        engine.one_source_per_period(results)  # must not raise
        engine.chain(results)

    def test_real_run_with_a_statement_and_positions(self):
        p = run("extract", CHEQUING, NSLSC, TD)
        self.assertEqual(p.returncode, 0, p.stderr)


class Assertions(Tmp):
    def test_accounts_balance_on_as_of_upgrades_to_asserted(self):
        acc = self.tmp / "accounts.toml"
        acc.write_text('[[account]]\ninstitution = "TD"\nacctid_last4 = "0123"\n'
                       '[[account.balance]]\nas_of = "2020-12-31"\namount = "287654.32"\n')
        rec = positions(run("extract", TD, "--accounts", acc).stdout)[0]
        self.assertEqual(rec["reconcile"]["status"], "asserted")

    def test_one_holder_view_entry_asserts_statement_and_position(self):
        acc = self.tmp / "accounts.toml"
        acc.write_text('[[account]]\ninstitution = "NSLSC"\nacctid_last4 = "0123"\n'
                       '[[account.balance]]\nas_of = "2020-03-31"\namount = "-14000.00"\n')
        recs = records(run("extract", NSLSC, "--accounts", acc).stdout)
        # The statement stays proven (its own rows prove it), the check passing beside them.
        self.assertEqual({r["record"]: r["reconcile"]["status"] for r in recs
                          if r["record"] != "transaction"},
                         {"statement": "proven", "position": "asserted"})
        for r in recs[:2]:
            self.assertIn(("external_assertion", True),
                          [(c["name"], c["ok"]) for c in r["reconcile"]["checks"]])

    def test_disagreeing_balance_is_refused(self):
        acc = self.tmp / "accounts.toml"
        acc.write_text('[[account]]\ninstitution = "TD"\nacctid_last4 = "0123"\n'
                       '[[account.balance]]\nas_of = "2020-12-31"\namount = "1.00"\n')
        p = run("extract", TD, "--accounts", acc)
        self.assertEqual((p.returncode, p.stdout), (3, ""))
        self.assertIn("external_assertion", p.stderr)


class Registry(unittest.TestCase):
    def _spec(self, **position):
        spec = {"institution": "X", "format": "pdftext", "identify": {"text": ["x"]},
                "keys": {"scheme": "content-occurrence/1"}}
        if position:
            spec["position"] = position
        return spec

    def test_position_kind_is_checked(self):
        registry.check_spec("x/ok", self._spec(kind="mortgage"))
        for bad in ({"kind": "card"}, {"kind": "loan", "primary": "payoff"}):
            with self.assertRaises(registry.AdapterError):
                registry.check_spec("x/bad", self._spec(**bad))

    def test_only_loan_adapters_declare_positions(self):
        declared = {a.id for a in registry.load() if "position" in a.spec}
        self.assertEqual(declared, POSITION_ADAPTERS)


class Identify(unittest.TestCase):
    def test_no_position_adapter_claims_a_statement_fixture(self):
        others = [c for c in cases() if not c.name.startswith(("mortgage-", "loan-statement-"))]
        self.assertGreaterEqual(len(others), 106)
        p = run("identify", *others)
        claims = {line.split("\t")[1] for line in p.stdout.splitlines()}
        self.assertFalse(claims & POSITION_ADAPTERS, claims & POSITION_ADAPTERS)

    def test_each_position_fixture_has_one_claimant(self):
        p = run("identify", CIBC, BMO, TD, NSLSC)
        self.assertEqual(p.returncode, 0, p.stdout)
        self.assertEqual({line.split("\t")[1] for line in p.stdout.splitlines()},
                         POSITION_ADAPTERS)


if __name__ == "__main__":
    unittest.main()
