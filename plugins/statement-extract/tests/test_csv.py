"""The declarative CSV driver's guard rails: never-read columns, spec validation, accounts."""
import copy
import tempfile
import tomllib
import unittest
from pathlib import Path

from helpers import ADAPTERS, run

from statement_extract import accounts, fixtures, registry

WISE = tomllib.loads((ADAPTERS / "wise" / "csv.toml").read_text(encoding="utf-8"))
HEADER = "TransferWise ID,Date,Payee Account Number,Amount\n"


class NeverRead(unittest.TestCase):
    def test_lint_refuses_a_payee_account_number_value(self):
        with tempfile.TemporaryDirectory() as d:
            fx = Path(d) / "adapters" / "x" / "fixtures"
            fx.mkdir(parents=True)
            (fx / "c.case.toml").write_text('synthetic = true\nquirk = "q"\nexit = 0\n')
            (fx / "c.expected.jsonl").write_text("")
            (fx / "c.csv").write_text(HEADER + "ID-1,01-01-2026,,1.00\n")
            self.assertEqual(fixtures.lint(Path(d)), [], "an empty column is fine")
            (fx / "c.csv").write_text(HEADER + "ID-1,01-01-2026,GB00X,1.00\n")
            problems = fixtures.lint(Path(d))
            self.assertEqual(len(problems), 1)
            self.assertIn("Payee Account Number", problems[0])
            self.assertNotIn("GB00X", problems[0], "lint names the column, never the value")
            p = run("fixture", "lint", d)
            self.assertEqual(p.returncode, 3)

    def test_spec_may_not_read_a_never_read_column(self):
        spec = copy.deepcopy(WISE)
        spec["csv"]["columns"]["memo"] = ["Payee Account Number"]
        with self.assertRaisesRegex(registry.AdapterError, "both read and dropped"):
            registry.check_spec("wise/csv", spec)

    def test_dropping_it_from_toml_does_not_unlock_it(self):
        spec = copy.deepcopy(WISE)
        spec["csv"]["drop"] = []
        spec["csv"]["columns"]["counterparty"] = ["Payee Account Number"]
        with self.assertRaisesRegex(registry.AdapterError, "both read and dropped"):
            registry.check_spec("wise/csv", spec)


class Spec(unittest.TestCase):
    def test_wise_spec_is_valid(self):
        registry.check_spec("wise/csv", WISE)

    def test_running_balance_needs_an_order(self):
        spec = copy.deepcopy(WISE)
        del spec["csv"]["order"]
        with self.assertRaisesRegex(registry.AdapterError, "proven order"):
            registry.check_spec("wise/csv", spec)

    def test_read_column_must_be_in_identify_header(self):
        spec = copy.deepcopy(WISE)
        spec["identify"]["header"] = [h for h in spec["identify"]["header"] if h != "Amount"]
        with self.assertRaisesRegex(registry.AdapterError, "not in identify.header"):
            registry.check_spec("wise/csv", spec)

    def test_unknown_csv_key(self):
        spec = copy.deepcopy(WISE)
        spec["csv"]["oder"] = "newest-first"
        with self.assertRaisesRegex(registry.AdapterError, "unknown \\[csv\\] key"):
            registry.check_spec("wise/csv", spec)


class OneSourcePerPeriod(unittest.TestCase):
    """Wise PDF and CSV key the same movements differently: a joint run must refuse, not
    emit them twice (measured on a real September: 188 rows instead of 139)."""
    FX = ADAPTERS / "wise" / "fixtures"

    def test_pdf_and_csv_for_one_period_refuse(self):
        p = run("extract", self.FX / "pdf-regular.layout.txt",
                self.FX / "wise-CAD-2026-01-01-to-2026-01-31.regular.csv")
        self.assertEqual(p.returncode, 3, p.stderr)
        self.assertIn("one source per period", p.stderr)
        self.assertEqual(p.stdout, "")

    def test_two_csv_exports_of_one_adapter_are_fine(self):
        p = run("extract", self.FX / "wise-CAD-2026-01-01-to-2026-01-31.regular.csv",
                self.FX / "wise-CAD-2026-01-01-to-2026-01-31.bom.csv")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("5 dup", p.stderr)


class Accounts(unittest.TestCase):
    def _load(self, text):
        with tempfile.NamedTemporaryFile("w", suffix=".toml", delete=False) as f:
            f.write(text)
        return accounts.load(Path(f.name))

    def test_currency_entry_matches_by_iso_code_only(self):
        accts = self._load('[[account]]\ninstitution = "Wise"\ncurrency = "CAD"\n')
        self.assertIsNotNone(accounts.find(accts, "Wise", "CAD"))
        self.assertIsNone(accounts.find(accts, "Wise", "USD"))

    def test_currency_entry_takes_no_last4(self):
        with self.assertRaises(accounts.AccountsError):
            self._load('[[account]]\ninstitution = "Wise"\ncurrency = "CAD"\nlast4 = "0001"\n')


if __name__ == "__main__":
    unittest.main()
