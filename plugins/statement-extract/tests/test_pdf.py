"""PDF text-layer path: hook rules, statement-line keys, chaining, b-copies, shape privacy."""
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from helpers import ADAPTERS, run

from statement_extract import fixtures, registry
from statement_extract.registry import AdapterError

SC = ADAPTERS / "scotiabank" / "fixtures"
DJ = ADAPTERS / "desjardins" / "fixtures"


def records(out: str) -> list[dict]:
    return [json.loads(line) for line in out.splitlines()]


class Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="se-pdf-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)


class HookRules(Tmp):
    def _adapter(self, toml: str, py: str | None) -> Path:
        d = self.tmp / "x"
        d.mkdir()
        (d / "pdf.toml").write_text(toml)
        if py is not None:
            (d / "pdf.py").write_text(py)
        return self.tmp

    TOML = ('institution = "X"\nformat = "pdftext"\n[identify]\ntext = ["X"]\n'
            '[keys]\nscheme = "content-occurrence/legacy-collapse-v0"\n')

    def test_hook_needs_why_not_toml_docstring(self):
        root = self._adapter(self.TOML, "def parse_lines(lines, spec, text):\n    return []\n")
        with self.assertRaisesRegex(AdapterError, "Why not TOML"):
            registry.load(root)

    def test_hook_may_define_only_the_named_hooks(self):
        root = self._adapter(self.TOML, 'def parse_lines(l, s, t):\n    """Why not TOML: x"""\n'
                             'def sneaky():\n    pass\n')
        with self.assertRaisesRegex(AdapterError, "only"):
            registry.load(root)

    def test_pdftext_adapter_needs_a_hook(self):
        with self.assertRaisesRegex(AdapterError, "parse_lines"):
            registry.load(self._adapter(self.TOML, None))

    def test_statement_line_keys_need_immutable(self):
        toml = self.TOML.replace("content-occurrence/legacy-collapse-v0", "statement-line/1")
        root = self._adapter(toml, 'def parse_lines(l, s, t):\n    """Why not TOML: x"""\n')
        with self.assertRaisesRegex(AdapterError, "immutable"):
            registry.load(root)

    def test_shipped_hooks_load(self):
        hooks = {a.id for a in registry.load() if a.hook is not None}
        self.assertEqual(hooks, {"desjardins/pdf", "scotiabank/chequing-pdf"})


def _next_month(dst: Path, opening: str, closing: str) -> Path:
    """The Jan 1-31 fixture (100.00 -> 90.00 after a 10.00 charge) re-dated Feb 2-27, with
    the given opening and closing. Placeholders first, so replacements cannot collide."""
    text = (SC / "chequing-year-rollover.layout.txt").read_text(encoding="utf-8")
    for a, b in (("$90.00", "@C$@"), ("90.00", "@C@"), ("$100.00", "@O$@"), ("100.00", "@O@"),
                 ("January 1, 2026", "February 2, 2026"), ("January 31, 2026", "February 27, 2026"),
                 ("Jan 1 ", "Feb 2 "), ("Dec 31", "Feb 10"), ("Jan 31", "Feb 27"),
                 ("@C$@", "$" + closing), ("@C@", closing), ("@O$@", "$" + opening),
                 ("@O@", opening)):
        text = text.replace(a, b)
    dst.write_text(text, encoding="utf-8")
    return dst


class Chaining(Tmp):
    """Two consecutive synthetic months of the closed Scotiabank chequing account."""

    JAN = SC / "chequing-year-rollover.layout.txt"

    def test_back_to_back_months_chain(self):
        # starts 2 days after Jan 31: a weekend cycle gap, still judged
        nxt = _next_month(self.tmp / "feb.layout.txt", "90.00", "80.00")
        p = run("extract", self.JAN, nxt)
        self.assertEqual(p.returncode, 0, p.stderr)
        chained = [c for r in records(p.stdout) if r["record"] == "statement"
                   for c in r["reconcile"]["checks"] if c["name"] == "chain_across_statements"]
        self.assertEqual([c["ok"] for c in chained], [True])
        # A digest inside free text tripped the leak gate on real data once: ids get their
        # own (exempt) field, never the note.
        self.assertNotRegex(chained[0]["note"], r"[0-9a-f]{12}")
        self.assertIn("previous_statement_id", chained[0])

    def test_broken_handover_is_refused(self):
        nxt = _next_month(self.tmp / "feb.layout.txt", "95.00", "85.00")
        alone = run("extract", nxt)
        self.assertEqual(alone.returncode, 0, "the month itself is proven: " + alone.stderr)
        p = run("extract", self.JAN, nxt)
        self.assertEqual((p.returncode, p.stdout), (3, ""), p.stderr)
        self.assertIn("does not continue", p.stderr)

    def test_a_missing_month_is_not_judged(self):
        nxt = _next_month(self.tmp / "feb.layout.txt", "95.00", "85.00")
        nxt.write_text(nxt.read_text().replace("February", "April").replace("Feb ", "Apr "))
        self.assertEqual(run("extract", self.JAN, nxt).returncode, 0)

    def test_same_month_delivered_twice_counts_once(self):
        src = SC / "chequing-regular.layout.txt"
        copy = self.tmp / "chequing-regular-b.layout.txt"
        copy.write_text(src.read_text(encoding="utf-8") + "\n", encoding="utf-8")  # other bytes
        p = run("extract", src, copy)
        self.assertEqual(p.returncode, 0, p.stderr)
        recs = records(p.stdout)
        st = [r for r in recs if r["record"] == "statement"]
        self.assertEqual(len(st), 2)
        self.assertEqual(len([r for r in recs if r["record"] == "transaction"]), 6)
        self.assertEqual(sum(s["counts"]["dup_in_run"] for s in st), 6)
        notes = [c["note"] for s in st for c in s["reconcile"]["checks"]
                 if c["name"] == "chain_across_statements"]
        self.assertEqual(notes, ["same period delivered again"])


class ShapePrivacy(unittest.TestCase):
    def test_values_blanked_labels_and_columns_kept(self):
        line = "Feb 9      Payroll deposit   ALEX SAMPLE 00001234     2,000.00    1,234.56"
        got = fixtures.shape_line(line)
        self.assertEqual(len(got), len(line))
        self.assertNotRegex(got, r"[0-8]")
        for word in ("ALEX", "SAMPLE", "Payroll"):
            self.assertNotIn(word, got)
        self.assertIn("Feb 9", got)
        self.assertIn("deposit", got)

    def test_lexicon_is_words_only(self):
        self.assertTrue(all(w.replace("-", "").isalpha() for w in fixtures.LABELS))


class PdfKit(unittest.TestCase):
    def test_amounts(self):
        from decimal import Decimal as D
        from statement_extract import pdfkit as k
        for text, want in (("1,234.56", D("1234.56")), ("$1,234.56", D("1234.56")),
                           ("-5.00", D("-5.00")), ("5.00-", D("-5.00")), ("(5.00)", D("-5.00")),
                           ("12.34 CR", D("-12.34")), ("12.34CR", D("-12.34"))):
            with self.subTest(text=text):
                self.assertEqual(k.amount(text), want)
                self.assertTrue(k.AMOUNT_RE.fullmatch(text))

    def test_dates_and_columns(self):
        from statement_extract import pdfkit as k
        self.assertEqual((k.month("Sep"), k.month("SEP"), k.month("September")), (9, 9, 9))
        self.assertEqual(k.infer_year(12, 1, 2026), 2025)
        self.assertEqual(k.infer_year(1, 1, 2026), 2026)
        cols = k.columns("  Description     Withdrawals     Deposits   Balance",
                         {"out": "Withdrawals", "in": "Deposits", "bal": "Balance"})
        self.assertEqual(k.nearest_column((26, 32), cols), "out")
        self.assertEqual(k.nearest_column((38, 44), cols), "in")

    def test_running_chain_day_groups(self):
        from decimal import Decimal as D
        from statement_extract import pdfkit as k
        rows = [{"amount": D("-5"), "balance": None}, {"amount": D("-5"), "balance": D("90")},
                {"amount": D("10"), "balance": D("100")}]
        self.assertTrue(k.running_chain(D("100"), rows).ok)
        rows[1]["balance"] = D("91")
        bad = k.running_chain(D("100"), rows)
        self.assertFalse(bad.ok)
        self.assertEqual(bad.actual, "breaks at row(s) [2, 3]")  # 91 + 10 != 100 either
        self.assertFalse(k.running_chain(D("0"), [{"amount": D("1"), "balance": None}]).ok)


class Reader(Tmp):
    def test_non_text_file_is_not_a_statement(self):
        f = self.tmp / "x.layout.txt"
        f.write_text("short")
        p = run("extract", f)
        self.assertEqual(p.returncode, 3)
        self.assertIn("a scan", p.stderr)


if __name__ == "__main__":
    unittest.main()
