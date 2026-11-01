"""plaid-pfc: the pin, strict validation, the crosswalk, the schema and refresh. Synthetic only."""
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from plaid_pfc import models, refresh, taxonomy  # noqa: E402
from plaid_pfc.cli import main  # noqa: E402

CSV = (
    "PFCv2 Primary,PFCv2 Detailed,PFCv2 Description,PFCv1 Primary,PFCv1 Detailed,PFCv1 Description\n"
    "Note: a note row,,,,,\n"
    "FOOD,FOOD_COFFEE,Coffee shops,FOOD,FOOD_COFFEE,Coffee\n"
    "INCOME,INCOME_SALARY,Salary,INCOME,INCOME_WAGES,Wages\n"
    "OTHER,OTHER_OTHER,Other,TRANSFER_IN / TRANSFER_OUT,TRANSFER_IN_X / TRANSFER_OUT_X,Other\n"
    "TRANSFER_IN,TRANSFER_IN_X,In,TRANSFER_IN,TRANSFER_IN_X,In\n"
)


def run(*argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = main(list(argv))
    return code, out.getvalue(), err.getvalue()


class Pin(unittest.TestCase):
    def test_pinned_counts_and_stamp(self):
        p = taxonomy.pinned()
        self.assertEqual((len(p["detailed"]), len(p["primary"]), p["version"]), (127, 18, "v2"))
        self.assertEqual(len(p["sha256"]), 64)
        self.assertTrue(p["source"].startswith("https://plaid.com/"))

    def test_every_name_is_its_primary_plus_a_rest(self):
        for d in taxonomy.pinned()["detailed"]:
            self.assertTrue(d["name"].startswith(d["primary"] + "_"), d["name"])
        # Plaid's CSV (2026-11-01) leaves exactly one description empty; a second one is a change.
        empty = [d["name"] for d in taxonomy.pinned()["detailed"] if not d["description"]]
        self.assertEqual(empty, ["OTHER_OTHER"])

    def test_known_v1_renames_are_crosswalked(self):
        self.assertEqual(taxonomy.crosswalk("INCOME_WAGES"), {"kind": "renamed", "v2": ["INCOME_SALARY"]})
        self.assertEqual(taxonomy.crosswalk("FOOD_AND_DRINK_COFFEE")["kind"], "identical")
        self.assertEqual(taxonomy.crosswalk("NOT_A_NAME")["kind"], "unknown")


class Validate(unittest.TestCase):
    def test_valid_names_and_the_review_marker_pass(self):
        code, _, _ = run("validate", "FOOD_AND_DRINK_COFFEE", "NEEDS_REVIEW", "INCOME_RENTAL")
        self.assertEqual(code, 0)

    def test_an_invented_name_with_a_real_primary_refuses(self):
        code, _, err = run("validate", "FOOD_AND_DRINK_COFFEE", "FOOD_AND_DRINK_PIZZA_PARTY")
        self.assertEqual(code, 3)
        self.assertIn("FOOD_AND_DRINK_PIZZA_PARTY", err)

    def test_a_v1_name_refuses_with_its_v2_hint(self):
        code, _, err = run("validate", "INCOME_WAGES")
        self.assertEqual(code, 3)
        self.assertIn("INCOME_SALARY", err)

    def test_csv_column_by_header(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "rules.csv"
            f.write_text("priority,category\n1,FOOD_AND_DRINK_COFFEE\n2,BOGUS_NAME\n")
            self.assertEqual(run("validate", "--csv", str(f), "--column", "category")[0], 3)
            f.write_text("priority,category\n1,FOOD_AND_DRINK_COFFEE\n")
            self.assertEqual(run("validate", "--csv", str(f), "--column", "category")[0], 0)


class Models(unittest.TestCase):
    def test_schema_enum_is_the_pin_plus_marker(self):
        s = models.schema("suggestion")
        enum = s["properties"]["category"]["enum"]
        self.assertEqual(len(enum), 128)
        self.assertIn("NEEDS_REVIEW", enum)
        self.assertEqual(s["required"], ["key", "category", "confidence", "method"])
        self.assertFalse(s["additionalProperties"])

    def test_suggestion_round_trip_and_refusal(self):
        d = {"key": "K1", "category": "FOOD_AND_DRINK_COFFEE", "confidence": 0.9, "method": "history",
             "evidence": [{"source": "history", "ref": "K0"}]}
        self.assertEqual(models.Suggestion.from_dict(d).to_dict()["category"], "FOOD_AND_DRINK_COFFEE")
        with self.assertRaises(models.Invalid):
            models.Suggestion.from_dict({**d, "category": "MADE_UP"})
        with self.assertRaises(models.Invalid):
            models.Suggestion.from_dict({**d, "confidence": 1.5})


class Refresh(unittest.TestCase):
    def test_parse_splits_joined_v1_cells_and_keeps_renames(self):
        p, c = refresh.parse(CSV.encode(), fetched="2026-01-01")
        self.assertEqual([d["name"] for d in p["detailed"]],
                         ["FOOD_COFFEE", "INCOME_SALARY", "OTHER_OTHER", "TRANSFER_IN_X"])
        self.assertEqual(c["v1_to_v2"]["INCOME_WAGES"], ["INCOME_SALARY"])
        self.assertEqual(set(c["v1_to_v2"]["TRANSFER_IN_X"]), {"OTHER_OTHER", "TRANSFER_IN_X"})
        self.assertNotIn("FOOD_COFFEE", c["v1_to_v2"])   # identity is implied, not stored

    def test_refresh_refuses_removals_without_acceptance(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "pfc.csv"
            f.write_text(CSV)
            code, out, _ = run("refresh", "--from", str(f))
            self.assertEqual(code, 3)
            self.assertGreater(len(json.loads(out)["removed"]), 100)

    def test_refresh_of_the_pinned_source_changes_nothing(self):
        p = taxonomy.pinned()
        self.assertEqual(refresh.diff(p, p), {"added": [], "removed": [], "redescribed": []})


if __name__ == "__main__":
    unittest.main()
