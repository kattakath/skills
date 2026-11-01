"""beancount-kit build: golden, pairs, refusals, idempotence. Needs an interpreter with beancount."""
import csv
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
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

    def test_clearing_account_nets_to_zero(self):
        from beancount import loader
        from beancount.core import realization
        entries, errors, _ = loader.load_file(str(GOLDEN))
        self.assertEqual(errors, [])
        real = realization.realize(entries)
        self.assertTrue(realization.get(real, "Assets:Transfers").balance.is_empty())

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

    def test_one_cent_drift_refuses(self):
        # Beancount's default tolerance would pass a figure one cent off; the build asserts exactly.
        later = scenario.stmt("ffff", "Bank", "••0002", "card", "CAD", "-60.01", "2026-02-15")
        (self.d / "card-b.jsonl").write_text(json.dumps(later) + "\n")
        code, err = self.run_build("--check-only")
        self.assertEqual(code, 3, err)
        self.assertIn("Balance failed", err)

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

    def test_overlapping_reexport_keeps_the_assertion(self):
        # A later "last 30 days" export repeats January's rows (same Keys) and adds one in
        # February. January's closing must still be asserted: nothing new is dated <= Jan 31.
        stmt = scenario.stmt("hhhh", "Bank", "••0002", "card", "CAD", "-65.00", "2026-02-10")
        rows = [dict(r, statement_id="hhhh") for r in scenario.CARD_A[1:]]
        rows.append(scenario.txn("hhhh", "Bank", "••0002", "CAD", "Bank|••0002|C4", "2026-02-05",
                                 "-5.00", "FEB FEE"))
        (self.d / "card-last30.jsonl").write_text("".join(json.dumps(r) + "\n" for r in [stmt, *rows]))
        # Re-export FIRST: dedupe then keeps its copy of the January rows, the order that made
        # the old provenance-blind check set January aside.
        files = [self.d / "card-last30.jsonl", *self.files.values()]
        code, err = self.run_build("--check-only", files=files)
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(err.splitlines()[0])["assertions_skipped_overlap"], 0)

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


    def pdf(self, sid, start, rows, closing="-60.00", end="2026-01-31"):
        s = scenario.stmt(sid, "Bank", "••0002", "card", "CAD", closing, end, fmt="pdftext")
        s["period"] = {"start": start, "end": end}
        recs = [s] + [scenario.txn(sid, "Bank", "••0002", "CAD", f"Bank|••0002|{d}|{a}|{t}|1",
                                   d, a, t) for d, a, t in rows]
        f = self.d / f"{sid}.jsonl"
        f.write_text("".join(json.dumps(r) + "\n" for r in recs))
        return f

    def report(self, files):
        code, err = self.run_build("--check-only", files=files)
        return code, json.loads(err.splitlines()[0]), err

    def test_pdf_over_a_bank_export_is_dropped_by_day(self):
        _, base, _ = self.report(list(self.files.values()))
        f = self.pdf("pppp", "2026-01-01", [("2026-01-03", "-360.00", "GROCER ONE"),
                                             ("2026-01-07", "300.00", "PAYMENT THANK YOU")])
        code, rep, err = self.report([*self.files.values(), f])
        self.assertEqual(code, 0, err)
        self.assertEqual((rep["rows"], rep["rows_dropped_overlap"]), (base["rows"], 2))
        # the PDF's closing is still asserted (it prints the kept rows' twins)
        self.assertEqual(rep["assertions_skipped_overlap"], base["assertions_skipped_overlap"])

    def test_partial_pdf_keeps_only_the_days_nothing_else_covers(self):
        _, base, _ = self.report(list(self.files.values()))
        f = self.pdf("qqqq", "2025-12-20", [("2025-12-22", "-10.00", "COFFEE"),
                                             ("2025-12-23", "10.00", "COFFEE REFUND"),
                                             ("2026-01-03", "-360.00", "GROCER ONE"),
                                             ("2026-01-07", "300.00", "PAYMENT THANK YOU")])
        code, rep, err = self.report([*self.files.values(), f])
        self.assertEqual(code, 0, err)
        self.assertEqual((rep["rows"], rep["rows_dropped_overlap"]), (base["rows"] + 2, 2))

    def test_sources_that_disagree_fail(self):
        # The PDF prints a charge the bank export lacks on a day the export owns: its closing
        # differs, and the build refuses instead of silently trusting either side.
        f = self.pdf("rrrr", "2026-01-01", [("2026-01-03", "-360.00", "GROCER ONE"),
                                             ("2026-01-07", "300.00", "PAYMENT THANK YOU"),
                                             ("2026-01-10", "-5.00", "EXTRA")], closing="-65.00")
        code, _, err = self.report([*self.files.values(), f])
        self.assertEqual(code, 3, err)

    def test_isolated_old_statement_is_bridged_with_a_labelled_gap(self):
        old = scenario.stmt("iiii", "Bank", "••0002", "card", "CAD", "-500.00", "2025-06-30")
        old["period"] = {"start": "2025-06-01", "end": "2025-06-30"}
        recs = [old, scenario.txn("iiii", "Bank", "••0002", "CAD", "Bank|••0002|OLD",
                                  "2025-06-10", "-500.00", "OLD CHARGE")]
        (self.d / "old.jsonl").write_text("".join(json.dumps(r) + "\n" for r in recs))
        out = self.d / "main.beancount"
        code, err = self.run_build("--out", str(out), files=[*self.files.values(),
                                                              self.d / "old.jsonl"])
        self.assertEqual(code, 0, err)
        text = out.read_text(encoding="utf-8")
        self.assertIn("2025-07-01 pad Liabilities:Bank:Card-0002 Equity:Gaps\n"
                      '  gap: "not recorded: 2025-07-01 to 2026-01-02 (186 days)"', text)


class Coverage(unittest.TestCase):
    def stmt(self, sid, start, end, opening, closing):
        s = scenario.stmt(sid, "Bank", "••0002", "card", "CAD", closing, end)
        s["period"] = {"start": start, "end": end}
        s["balances"] = dict(s["balances"], opening=opening)
        return s

    def run_cov(self, records):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "c.jsonl"
            f.write_text("".join(json.dumps(r) + "\n" for r in records))
            out = io.StringIO()
            with redirect_stdout(out), redirect_stderr(io.StringIO()):
                code = main(["coverage", str(f), "--json"])
            return code, json.loads(out.getvalue()) if code in (0, 3) else None

    def test_continuous_chain_passes(self):
        code, c = self.run_cov([self.stmt("a1", "2026-01-01", "2026-01-31", "0.00", "-10.00"),
                                self.stmt("a2", "2026-02-01", "2026-02-28", "-10.00", "-20.00")])
        self.assertEqual((code, c["balance_breaks"], c["date_holes"]), (0, 0, 0))

    def test_break_between_adjoining_statements_fails(self):
        code, c = self.run_cov([self.stmt("a1", "2026-01-01", "2026-01-31", "0.00", "-10.00"),
                                self.stmt("a2", "2026-02-01", "2026-02-28", "-15.00", "-20.00")])
        self.assertEqual(code, 3)
        self.assertEqual(c["accounts"][0]["balance_breaks"][0]["next_opening"], "-15.00")

    def test_balance_moving_across_a_hole_is_bridged_not_a_break(self):
        code, c = self.run_cov([self.stmt("a1", "2026-01-01", "2026-01-31", "0.00", "-10.00"),
                                self.stmt("a2", "2026-03-01", "2026-03-31", "-15.00", "-20.00")])
        self.assertEqual((code, c["balance_breaks"], c["bridged_holes"]), (0, 0, 1))
        self.assertEqual(c["accounts"][0]["date_holes"][0]["days"], 28)

    def test_break_checked_without_start_dates(self):
        a = self.stmt("a1", None, "2026-01-31", "0.00", "-10.00")
        b = self.stmt("a2", None, "2026-02-28", "-15.00", "-20.00")
        code, c = self.run_cov([a, b])
        self.assertEqual((code, c["balance_breaks"], c["accounts"][0]["periods_without_start"]),
                         (3, 1, 2))

    def test_second_source_for_same_dates_fails(self):
        q = self.stmt("q", "2026-01-01", "2026-01-31", "0.00", "-10.00")
        p = self.stmt("p", "2026-01-01", "2026-01-31", "0.00", "-10.00")
        t = lambda sid, k, d, amt: scenario.txn(sid, "Bank", "••0002", "CAD", k, d, amt, "TIM")
        code, c = self.run_cov([q, p, t("q", "FIT1", "2026-01-05", "-2.00"),
                                t("q", "FIT2", "2026-01-05", "-2.00"),
                                t("p", "2026-01-05|-2.00|TIM|1", "2026-01-05", "-2.00")])
        self.assertEqual((code, c["doubled_rows"]), (3, 1))
        # one statement with two identical charges, plus a same-Key re-export: not doubled
        code, c = self.run_cov([q, p, t("q", "FIT1", "2026-01-05", "-2.00"),
                                t("q", "FIT2", "2026-01-05", "-2.00"),
                                t("p", "FIT1", "2026-01-05", "-2.00")])
        self.assertEqual((code, c["doubled_rows"]), (0, 0))

    def test_pdf_over_bank_export_is_resolved_not_doubled(self):
        q = self.stmt("q", "2026-01-01", "2026-01-31", "0.00", "-2.00")
        p = dict(self.stmt("p", "2026-01-01", "2026-01-31", "0.00", "-2.00"))
        p["source"] = dict(p["source"], format="pdftext")
        t = lambda sid, k: scenario.txn(sid, "Bank", "••0002", "CAD", k, "2026-01-05", "-2.00", "TIM")
        code, c = self.run_cov([q, p, t("q", "FIT1"), t("p", "2026-01-05|-2.00|TIM|1")])
        self.assertEqual((code, c["doubled_rows"], c["rows_resolved_overlap"]), (0, 0, 1))

    def test_overlap_counted_once_lookalike_listed_conflict_fails(self):
        s = self.stmt("a1", "2026-01-01", "2026-01-31", "0.00", "-10.00")
        t = lambda k, amt: scenario.txn("a1", "Bank", "••0002", "CAD", k, "2026-01-05", amt, "TIM")
        code, c = self.run_cov([s, t("K1", "-2.00"), t("K1", "-2.00"), t("K2", "-2.00")])
        self.assertEqual((code, c["unique_keys"], c["keys_in_several_files"]), (0, 2, 1))
        self.assertEqual(c["lookalikes"][0]["count"], 2)
        code, c = self.run_cov([s, t("K1", "-2.00"), t("K1", "-3.00")])
        self.assertEqual((code, c["key_conflicts"]), (3, ["K1"]))


class Groups(unittest.TestCase):
    def test_merchant_key_strips_masks_and_numbers(self):
        from beancount_kit.groups import merchant, pattern
        self.assertEqual(merchant("Deposit ••0615 Free Interac E-Transfer", "")[0], "DEPOSIT FREE")
        self.assertEqual(merchant("SEND E-TFR ***vYR", "")[0], "SEND TFR")
        self.assertEqual(merchant("", "E-TRANSFER ••4049;NAME;Internet Banking")[0], "TRANSFER")
        self.assertEqual(merchant("MOBIL@ - 4180", "X")[0], "MOBIL")
        self.assertEqual(pattern(["GOOGLE", "CLOUD"]), r"\bGOOGLE\b.*\bCLOUD\b")

    def test_groups_cover_every_flagged_entry_and_leave_the_journal(self):
        before = GOLDEN.read_bytes()
        from beancount_kit.groups import groups
        rows = groups(GOLDEN)
        self.assertEqual(sum(r["count"] for r in rows), 2)
        self.assertEqual({r["group"] for r in rows}, {"MYSTERY MERCHANT", "SEND TO"})
        self.assertEqual(GOLDEN.read_bytes(), before)


try:
    import smart_importer  # noqa: F401
    HAVE_SI = True
except ImportError:
    HAVE_SI = False


@unittest.skipUnless(HAVE_SI, "smart_importer not installed (optional dependency)")
class Suggest(unittest.TestCase):
    def test_one_suggestion_per_flagged_entry_and_journal_untouched(self):
        before = GOLDEN.read_bytes()
        out = io.StringIO()
        from beancount_kit import suggest
        rep = suggest.suggest(GOLDEN, out)
        rows = list(csv.reader(io.StringIO(out.getvalue())))
        self.assertEqual(rows[0], ["key", "suggestion"])
        self.assertEqual([r[0] for r in rows[1:]], ["Wallet|USD|3", "Wallet|USD|4"])
        trained = {"INCOME_SALARY", "FOOD_AND_DRINK_GROCERIES", "LOAN_PAYMENTS_MORTGAGE_PAYMENT",
                   "GENERAL_MERCHANDISE_CONVENIENCE_STORES", "TRANSFER_OUT_ACCOUNT_TRANSFER"}
        self.assertTrue(all(r[1] in trained for r in rows[1:]), rows)
        self.assertEqual((rep["trained_on"], rep["suggested"]), (5, 2))
        self.assertEqual(GOLDEN.read_bytes(), before)

    def test_cli_refuses_a_journal_with_errors(self):
        with tempfile.TemporaryDirectory() as d:
            bad = Path(d) / "bad.beancount"
            bad.write_text("2026-01-01 balance Assets:Nope  1 CAD\n")
            err = io.StringIO()
            with redirect_stderr(err):
                code = main(["suggest", "--journal", str(bad)])
            self.assertEqual(code, 3, err.getvalue())

if __name__ == "__main__":
    unittest.main()
