"""Golden byte-compare: every fixture case's exit code, stderr marker and exact stdout.

Regenerate after an INTENDED output change with STATEMENT_EXTRACT_UPDATE_GOLDENS=1, then
review the diff: a golden that moves without a reason is the bug this test exists to catch.
"""
import os
import re
import unittest

from helpers import case_args, cases, golden_path, run

UPDATE = os.environ.get("STATEMENT_EXTRACT_UPDATE_GOLDENS") == "1"
# The engine's own content hash moves with every code edit; everything else must not.
ENGINE = re.compile(r'"extractor_version": "sha256:[0-9a-f]{16}"')


def stable(text: str) -> str:
    return ENGINE.sub('"extractor_version": "<engine>"', text)


class FixtureCases(unittest.TestCase):
    def test_every_case(self):
        found = cases()
        self.assertGreater(len(found), 0)
        for inp in found:
            with self.subTest(case=f"{inp.parent.parent.name}/{inp.stem}"):
                args, spec = case_args(inp)
                p = run(*args)
                self.assertEqual(p.returncode, spec["exit"], p.stderr)
                if spec.get("stderr_has"):
                    self.assertIn(spec["stderr_has"], p.stderr)
                if spec["exit"] != 0:
                    self.assertEqual(p.stdout, "", "a refusal must emit nothing")
                g = golden_path(inp)
                if UPDATE:
                    g.write_text(stable(p.stdout), encoding="utf-8")
                self.assertEqual(stable(p.stdout), g.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
