"""The MIT OFX reader: grammar, text semantics, strictness, identifiers."""
import unittest

from helpers import PLUGIN  # noqa: F401

from statement_extract.readers import ofx

V1 = (b"OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\nCHARSET:1252\r\n\r\n"
      b"<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS>"
      b"<FI><ORG>SYNTH<FID>0001</FI><INTU.BID>0002</SONRS></SIGNONMSGSRSV1>"
      b"<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STMTRS><CURDEF>CAD<BANKACCTFROM><BANKID>0000004"
      b"<ACCTID>00000009999<ACCTTYPE>CHECKING</BANKACCTFROM></STMTRS></STMTTRNRS>"
      b"</BANKMSGSRSV1></OFX>")


class Grammar(unittest.TestCase):
    def test_parse_v1(self):
        doc = ofx.parse(V1)
        self.assertEqual((doc.version, doc.charset), (1, "1252"))
        fi = doc.root.get("SIGNONMSGSRSV1").get("SONRS").get("FI")
        self.assertEqual(fi.val("ORG"), "SYNTH")

    def test_text_strip_then_unescape_like_ofxtools(self):
        root = ofx.build("<X><NAME>  A &amp; B&nbsp;  </X>")
        # strip happens BEFORE unescape, so a trailing &nbsp; survives as a space
        self.assertEqual(root.get("X").val("NAME"), "A & B ")
        self.assertEqual(ofx.build("<N>&#65;</N>").get("N").text, "&#65;")

    def test_mismatched_close_is_an_error(self):
        with self.assertRaisesRegex(ofx.OFXError, "closes"):
            ofx.build("<A><B><C>1</A>")

    def test_unclosed_is_an_error(self):
        with self.assertRaisesRegex(ofx.OFXError, "never closed"):
            ofx.build("<A><B>")

    def test_tail_text_is_an_error(self):
        with self.assertRaises(ofx.OFXError):
            ofx.build("<A></A>junk<B></B>")

    def test_unknown_tag_refused_proprietary_ignored(self):
        with self.assertRaisesRegex(ofx.OFXError, "unknown tag <BOGUS>"):
            ofx.parse(V1.replace(b"<CURDEF>CAD", b"<CURDEF>CAD<BOGUS>1"))
        ofx.parse(V1.replace(b"<CURDEF>CAD", b"<CURDEF>CAD<INTU.X>1"))

    def test_empty_leaf_becomes_aggregate_and_is_refused(self):
        with self.assertRaisesRegex(ofx.OFXError, "ACCTTYPE"):
            ofx.parse(V1.replace(b"<ACCTTYPE>CHECKING", b"<ACCTTYPE>"))

    def test_bad_charset_and_header(self):
        with self.assertRaises(ofx.OFXError):
            ofx.parse(V1.replace(b"CHARSET:1252", b"CHARSET:EBCDIC"))
        with self.assertRaises(ofx.OFXError):
            ofx.parse(b"not ofx at all")


class Dates(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(ofx.parse_dt("20261031"), ("2026-10-31", "2026-10-31"))

    def test_offset_shifts_key_date_to_utc(self):
        self.assertEqual(ofx.parse_dt("20261015230000[-5:EST]"), ("2026-10-15", "2026-10-16"))
        self.assertEqual(ofx.parse_dt("20261015010000.000[+5.30:IST]"),
                         ("2026-10-15", "2026-10-14"))

    def test_bad(self):
        with self.assertRaises(ofx.OFXError):
            ofx.parse_dt("2026-10-31")


class Identifiers(unittest.TestCase):
    def test_never_account_ids(self):
        ids = ofx.identifiers(V1)
        self.assertEqual(ids, {"ORG": ["SYNTH"], "FID": ["0001"], "INTU.BID": ["0002"],
                               "CURDEF": ["CAD"]})
        self.assertNotIn("9999", repr(ids))

    def test_not_ofx(self):
        self.assertEqual(ofx.identifiers(b"%PDF-1.4"), {})


if __name__ == "__main__":
    unittest.main()
