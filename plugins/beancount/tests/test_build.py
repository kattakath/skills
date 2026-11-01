"""beancount-kit build: golden, pairs, refusals, idempotence. Needs an interpreter with beancount."""
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "lib"))
sys.path.insert(0, str(HERE))

import scenario  # noqa: E402
from beancount_kit.cli import main  # noqa: E402

GOLDEN = HERE / "golden" / "scenario.beancount"


class Build(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        self.files = scenario.write(self.d)

    def tearDown(self):
        self.tmp.cleanup()

    def run_build(self, *extra, files=None):
        argv = ["build", *(str(f) for f in (files or self.files.values())),
                "--ledger", str(self.d / "ledger.toml"), "--rules", str(self.d / "rules.csv"),
                "--decisions", str(self.d / "decisions.csv"), *extra]
        err = io.StringIO()
        with redirect_stderr(err):
            code = main(argv)
        return code, err.getvalue()

    def test_golden(self):
        out = self.d / "main.beancount"
        code, err = self.run_build("--out", str(out))
        self.assertEqual(code, 0, err)
        self.assertEqual(out.read_text(encoding="utf-8"), GOLDEN.read_text(encoding="utf-8"))

    def test_golden_passes_beancount(self):
        from beancount import loader
        _, errors, _ = loader.load_file(str(GOLDEN))
        self.assertEqual(errors, [])

    def test_rebuild_is_idempotent(self):
        out = self.d / "main.beancount"
        self.run_build("--out", str(out))
        first = out.read_bytes()
        code, err = self.run_build("--out", str(out))
        self.assertEqual(code, 0)
        self.assertIn("journal unchanged", err)
        self.assertEqual(out.read_bytes(), first)

    def test_pairs(self):
        p = self.d / "pairs.json"
        self.run_build("--check-only", "--emit-pairs", str(p))
        self.assertEqual(sorted(map(tuple, json.loads(p.read_text(encoding="utf-8")))), [
            ("Bank|••0001|F2", "Bank|••0002|C2", "exact"),
            ("Bank|••0001|F3", "Wallet|CAD|1", "fee"),
            ("Wallet|CAD|2", "Wallet|USD|1", "conversion"),
            ("Wallet|CAD|3", "Wallet|USD|2", "cross-currency"),
        ])

    def test_report(self):
        code, err = self.run_build("--check-only")
        rep = json.loads(err.splitlines()[0])
        self.assertEqual((code, rep["rows"], rep["review"], rep["transfer_residue"],
                          rep["unpaired_must_pair"]), (0, 15, 2, 1, 1))
        self.assertIn("unpaired transfer leg: Bank|••0001|F6", err)

    def test_wrong_schema_is_usage(self):
        bad = self.d / "bad.jsonl"
        bad.write_text('{"schema": "statement-extract/0", "record": "statement"}\n')
        code, err = self.run_build("--check-only", files=[bad])
        self.assertEqual(code, 2, err)

    def test_key_conflict_refuses(self):
        recs = [scenario.CARD_B[0], dict(scenario.CARD_B[1], amount="301.00")]
        f = self.d / "card-b.jsonl"
        f.write_text("".join(json.dumps(r) + "\n" for r in recs))
        code, err = self.run_build("--check-only")
        self.assertEqual(code, 3)
        self.assertIn("Bank|••0002|C2", err)

    def test_unmapped_account_refuses(self):
        led = self.d / "ledger.toml"
        led.write_text(led.read_text().replace('label = "••0002"', 'label = "••9999"'))
        code, err = self.run_build("--check-only")
        self.assertEqual(code, 3)
        self.assertIn("Bank ••0002", err)

    def test_unknown_decision_key_refuses(self):
        dec = self.d / "decisions.csv"
        dec.write_text(dec.read_text() + "Bank|••0001|GONE,INCOME_SALARY,,,,,\n")
        code, err = self.run_build("--check-only")
        self.assertEqual(code, 3)
        self.assertIn("Bank|••0001|GONE", err)

    def test_wrong_balance_refuses_and_writes_nothing(self):
        # The FIRST figure only sizes the opening pad; a later one that disagrees must refuse.
        later = scenario.stmt("ffff", "Bank", "••0002", "card", "CAD", "-61.00", "2026-02-15")
        (self.d / "card-b.jsonl").write_text(json.dumps(later) + "\n")
        out = self.d / "main.beancount"
        code, err = self.run_build("--out", str(out))
        self.assertEqual(code, 3, err)
        self.assertIn("Balance failed", err)
        self.assertFalse(out.exists())

    def test_overlapping_statement_dates_set_the_assertion_aside(self):
        # The February statement prints a fee dated January 31, the January statement's last
        # day. No day boundary separates them, so January's figure is set aside, not padded.
        feb = [scenario.stmt("gggg", "Bank", "••0002", "card", "CAD", "-65.00", "2026-02-28"),
               scenario.txn("gggg", "Bank", "••0002", "CAD", "Bank|••0002|C3", "2026-01-31",
                            "-5.00", "MONTHLY FEE")]
        (self.d / "card-feb.jsonl").write_text("".join(json.dumps(r) + "\n" for r in feb))
        files = [*self.files.values(), self.d / "card-feb.jsonl"]
        code, err = self.run_build("--check-only", files=files)
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(err.splitlines()[0])["assertions_skipped_overlap"], 2)
        self.assertIn("not asserted (a later statement has rows dated <= 2026-01-31)", err)

    def test_gap_pads_from_equity_gaps(self):
        led = self.d / "ledger.toml"
        led.write_text(led.read_text() + '\n[[gap]]\naccount = "Liabilities:Bank:Card-0002"\n'
                       'date = "2026-01-04"\nreason = "missing statement"\n')
        recs = [dict(scenario.CARD_A[0], balances=dict(scenario.CARD_A[0]["balances"],
                                                        closing="-75.00"))]
        recs += scenario.CARD_A[1:]
        (self.d / "card-a.jsonl").write_text("".join(json.dumps(r) + "\n" for r in recs))
        (self.d / "card-b.jsonl").write_text("")
        out = self.d / "main.beancount"
        code, err = self.run_build("--out", str(out))
        self.assertEqual(code, 0, err)
        self.assertIn("2026-01-04 pad Liabilities:Bank:Card-0002 Equity:Gaps",
                      out.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
