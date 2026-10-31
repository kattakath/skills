"""Three cases per repair: before->after, applied twice == once, no-op on clean input."""
import unittest

from helpers import PLUGIN  # noqa: F401

from statement_extract.repairs import ofx as repairs

CASES = {
    "empty-accttype": (
        b"<BANKACCTFROM><ACCTID>0000001<ACCTTYPE>\r\n</BANKACCTFROM>",
        b"<BANKACCTFROM><ACCTID>0000001<ACCTTYPE>CHECKING</BANKACCTFROM>",
        b"<BANKACCTFROM><ACCTID>0000001<ACCTTYPE>SAVINGS\r\n</BANKACCTFROM>",
    ),
    "cc-stmttrnrs-wrapper": (
        b"<CREDITCARDMSGSRSV1><STMTTRNRS><CCSTMTRS></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>",
        b"<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>",
        b"<BANKMSGSRSV1><STMTTRNRS></STMTTRNRS></BANKMSGSRSV1>",
    ),
    "charset-1252-utf8-body": (
        b"OFXHEADER:100\r\nCHARSET:1252\r\n\r\n<MEMO>PR\xc3\x8aT",
        b"OFXHEADER:100\r\nCHARSET:1252\r\n\r\n<MEMO>PR\xcaT",
        b"OFXHEADER:100\r\nCHARSET:1252\r\n\r\n<MEMO>CAF\xe9",
    ),
    "ccacctfrom-accttype": (
        b"<CCACCTFROM><ACCTID>0000001<ACCTTYPE>CREDITLINE\r\n</CCACCTFROM>",
        b"<CCACCTFROM><ACCTID>0000001\r\n</CCACCTFROM>",
        b"<BANKACCTFROM><ACCTID>0000001<ACCTTYPE>CREDITLINE\r\n</BANKACCTFROM>",
    ),
}


class Repairs(unittest.TestCase):
    def test_registry_covered(self):
        self.assertEqual({r.name for r in repairs.REPAIRS}, set(CASES))

    def test_three_cases_each(self):
        for r in repairs.REPAIRS:
            before, after, clean = CASES[r.name]
            with self.subTest(repair=r.name):
                self.assertEqual(r.fn(before), after)
                self.assertEqual(r.fn(r.fn(before)), after)
                self.assertEqual(r.fn(clean), clean)

    def test_apply_reports_only_what_fired(self):
        raw, fired = repairs.apply(CASES["empty-accttype"][0], [r.name for r in repairs.REPAIRS])
        self.assertEqual(fired, ["empty-accttype"])
        self.assertEqual(raw, CASES["empty-accttype"][1])

    def test_unknown_repair_rejected(self):
        with self.assertRaises(ValueError):
            repairs.apply(b"", ["no-such-repair"])


if __name__ == "__main__":
    unittest.main()
