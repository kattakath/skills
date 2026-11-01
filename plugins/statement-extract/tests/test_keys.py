"""Frozen key normalisers and key builders. These bytes are already stored downstream."""
import hashlib
import inspect
import json
import unittest
from decimal import Decimal

from helpers import GOLDEN, case_name, cases, golden_path

from statement_extract import engine, keys, mask


class FrozenNormalisers(unittest.TestCase):
    def test_golden_vectors_from_the_legacy_code(self):
        doc = json.loads((GOLDEN / "normalisers.json").read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(doc["vectors"]), 25)
        for v in doc["vectors"]:
            for scheme, fn in keys.FROZEN.items():
                if "/legacy-" not in scheme:
                    continue
                with self.subTest(scheme=scheme, input=v["in"]):
                    self.assertEqual(fn(v["in"]), v[scheme.split("/")[1]])

    def test_content_v1_vectors(self):
        doc = json.loads((GOLDEN / "content-occurrence-1.json").read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(doc["vectors"]), 30)
        for v in doc["vectors"]:
            with self.subTest(input=v["in"]):
                self.assertEqual(keys.content_v1(v["in"]), v["out"])
                self.assertFalse(mask.leaks(v["out"]) and not mask.leaks(v["in"] or ""))

    def test_source_unchanged(self):
        doc = json.loads((GOLDEN / "frozen.json").read_text(encoding="utf-8"))
        self.assertEqual(set(doc["hashes"]), set(keys.FROZEN))
        for scheme, fn in keys.FROZEN.items():
            with self.subTest(scheme=scheme):
                got = hashlib.sha256(inspect.getsource(fn).encode()).hexdigest()
                self.assertEqual(got, doc["hashes"][scheme], "frozen normaliser edited in place")

    def test_legacy_qfx_keeps_internal_whitespace(self):
        self.assertEqual(keys.legacy_qfx_v0("A  B"), "A  B")
        self.assertEqual(keys.legacy_collapse_v0("A  B"), "A B")


class Builders(unittest.TestCase):
    def test_last4_ref(self):
        self.assertEqual(keys.last4_ref(" 00000001234 "), "••1234")

    def test_fitid_key(self):
        self.assertEqual(keys.fitid_key("TD", "••1234", "0000X"), "TD|••1234|0000X")

    def test_content_key_occurrence_and_half_even(self):
        k = keys.ContentKeyer("content-occurrence/legacy-qfx-v0", "Scotiabank", "••4401")
        a = k.key("2026-10-08", Decimal("-1.005"), "ODD  FEE")
        b = k.key("2026-10-08", Decimal("-1.005"), "ODD  FEE")
        c = k.key("2026-10-08", Decimal("-1.015"), "ODD  FEE")
        self.assertEqual(a, "Scotiabank|••4401|2026-10-08|-1.00|ODD  FEE|1")
        self.assertEqual(b, "Scotiabank|••4401|2026-10-08|-1.00|ODD  FEE|2")
        self.assertEqual(c, "Scotiabank|••4401|2026-10-08|-1.02|ODD  FEE|1")

    def test_unknown_scheme_refused(self):
        with self.assertRaises(ValueError):
            keys.ContentKeyer("content-hash/1", "X", "••0000")


class KeyTextRescue(unittest.TestCase):
    """engine._key_text: only text whose frozen key would leak is touched, so no stored key
    can move; the rescue itself is frozen because rescued keys are stored."""

    def test_star_digit_reference_rescued(self):
        n = keys.content_v1
        self.assertTrue(mask.leaks(n("SEND E-TFR ***4ab")))
        self.assertEqual(engine._key_text(n, "SEND E-TFR ***4ab"), "SEND E-TFR ••4ab")
        self.assertEqual(engine._key_text(n, "REF **12*3"), "REF ••123")
        self.assertFalse(mask.leaks(n(engine._key_text(n, "SEND E-TFR ***4ab"))))

    def test_text_that_does_not_leak_is_untouched(self):
        n = keys.content_v1
        for s in ("SEND E-TFR ***Ab1", "CARD ****1234", "PAYEE *****12*3456", "A  B", "", None,
                  "TO:00001234567"):
            with self.subTest(s=s):
                self.assertIs(engine._key_text(n, s), s)

    def test_text_that_still_leaks_is_left_to_the_gate(self):
        n = keys.content_v1
        out = engine._key_text(n, "ACCT 4500 12*")
        self.assertTrue(mask.leaks(n(out)))


class LegacyDifferential(unittest.TestCase):
    """The plugin emits exactly the keys the legacy extractor emitted on the same files."""

    def test_keys_match_legacy_extractor(self):
        doc = json.loads((GOLDEN / "legacy-keys.json").read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(doc["cases"]), 40)
        by_case = {case_name(p): p for p in cases()}
        for case, legacy in doc["cases"].items():
            with self.subTest(case=case):
                lines = golden_path(by_case[case]).read_text(encoding="utf-8").splitlines()
                mine = sorted(r["key"] for r in map(json.loads, lines)
                              if r["record"] == "transaction")
                self.assertEqual(mine, legacy)


if __name__ == "__main__":
    unittest.main()
