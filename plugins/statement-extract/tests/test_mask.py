"""Display masking: each rule with a positive and a negative case, then the leak gate."""
import unittest

from helpers import PLUGIN  # noqa: F401  (puts lib/ on sys.path)

from statement_extract import mask

RULE_CASES = {
    "collapse-whitespace": [("  A \t B  ", "A B"), ("A B", "A B")],
    "desjardins-card": [("0000 12** **** 0000", "••0000"), ("0000 12 0000", "0000 12 0000")],
    "star-masked": [("FROM - *****12*3456", "FROM - ••3456"), ("e-Transfer *1234", "e-Transfer *1234")],
    "first4-stars-last4": [("CC#4500********2204", "CC#••2204"), ("CC#4500**2204", "CC#4500**2204")],
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
                      "0000 12** **** 0000", "0000-1234-5678-9012"):
            with self.subTest(given=given):
                self.assertFalse(mask.leaks(mask.mask(given)))


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
