"""Display masking: each rule with a positive and a negative case, then the leak gate."""
import unittest

from helpers import PLUGIN  # noqa: F401  (puts lib/ on sys.path)

from statement_extract import mask

RULE_CASES = {
    "collapse-whitespace": [("  A \t B  ", "A B"), ("A B", "A B")],
    "desjardins-card": [("0000 12** **** 0000", "••0000"), ("0000 12 0000", "0000 12 0000")],
    "star-masked": [("FROM - *****12*3456", "FROM - ••3456"), ("e-Transfer *1234", "e-Transfer *1234")],
    "first4-stars-last4": [("CC#4500********2204", "CC#••2204"), ("CC#4500**2204", "CC#4500**2204")],
    "star-short-tail": [("FROM 00012/****345", "FROM 00012/••345"), ("NOTE ** 12", "NOTE ** 12")],
    "grouped-digits": [("ACCT 0000 1234 567", "ACCT ••4567"), ("ON 2026-10-31 OK", "ON 2026-10-31 OK"),
                       ("PH 416 555", "PH 416 555")],
    "long-digit-run": [("TO:0000123456789", "TO:••6789"), ("REF 123456", "REF 123456")],
}


class Rules(unittest.TestCase):
    def test_every_rule_has_cases(self):
        self.assertEqual({r.name for r in mask.RULES}, set(RULE_CASES))
        for r in mask.RULES:
            self.assertTrue(r.provenance)

    def test_rule_cases(self):
        rules = {r.name: r for r in mask.RULES}
        for name, pairs in RULE_CASES.items():
            for given, want in pairs:
                with self.subTest(rule=name, given=given):
                    self.assertEqual(rules[name].apply(given), want)

    def test_whole_pipeline(self):
        self.assertEqual(mask.mask(None), "")
        self.assertEqual(mask.mask("PAY  TO:0000123456789  NOW"), "PAY TO:••6789 NOW")
        self.assertEqual(mask.mask("DATE 31/10/2026"), "DATE 31/10/2026")

    def test_masked_output_never_leaks(self):
        for given in ("TO:0000123456789", "CC#4500********2204", "*****12*3456",
                      "0000 12** **** 0000", "0000-1234-5678-9012", "00012/****345"):
            with self.subTest(given=given):
                self.assertFalse(mask.leaks(mask.mask(given)))


class P5Findings(unittest.TestCase):
    """The agentic-ledger equivalence gate's display findings (2026-11-01), as synthetic shapes.
    Each pins what the operator decided; each also stays leak-free."""

    CASES = [
        # F4 (defect): cents were glued onto the account number that followed them.
        ("PAID $9.99 0000123456", "PAID $9.99 ••3456"),
        ("FEE 12,50 0000123456", "FEE 12,50 ••3456"),
        # F1 (tighten): phone shapes stay readable; a 7+ run beside a short group is masked alone.
        ("CALL 416-555-0199", "CALL 416-555-0199"),
        ("CALL 1-800-555-0199 NOW", "CALL 1-800-555-0199 NOW"),
        ("REF 999-0001234567", "REF 999-••4567"),
        # F2 (tighten): a short number before a tail is kept; two tails stay two.
        ("TFR 123 0000123456", "TFR 123 ••3456"),
        ("A 0001234567 0007654321", "A ••4567 ••4321"),
        ("TO 12 *****4567", "TO 12 ••4567"),
        # Still masked: grouped account numbers made only of short groups.
        ("ACCT 0000 1234 567", "ACCT ••4567"),
        ("Transfer from 00000 01234 56", "Transfer from ••3456"),
        ("Mortgage #000012-3", "Mortgage #••0123"),
        ("CARD 0000-1234-5678-9012", "CARD ••9012"),
    ]

    def test_shapes(self):
        for given, want in self.CASES:
            with self.subTest(given=given):
                got = mask.mask(given)
                self.assertEqual(got, want)
                self.assertFalse(mask.leaks(got))

    def test_keys_unaffected(self):
        # Display masking changed; the frozen key normaliser did not.
        from statement_extract import keys
        self.assertEqual(keys.content_v1("TFR 123 0000123456"), "TFR ••3456")


class LeakGate(unittest.TestCase):
    def test_trips(self):
        for s in ("1234567", "0000 12*", "4500****2204", "**1", "•••1234"):
            with self.subTest(s=s):
                self.assertTrue(mask.leaks(s))

    def test_quiet(self):
        for s in ("••1234", "123456", "2026-10-31", "e-Transfer *1234", "TD|••1234|"):
            with self.subTest(s=s):
                self.assertFalse(mask.leaks(s))


if __name__ == "__main__":
    unittest.main()
