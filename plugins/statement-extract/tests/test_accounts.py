"""accounts.toml: a reissued card maps an old card number to the current account."""
import tempfile
import unittest
from pathlib import Path

import helpers  # noqa: F401  (puts lib on sys.path, as every test module does)
from statement_extract import accounts


def load(text: str):
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "accounts.toml"
        p.write_text(text, encoding="utf-8")
        return accounts.load(p)


class Reissued(unittest.TestCase):
    def test_reissued_entry_accepts_the_old_number_in_the_header(self):
        [a] = load('[[account]]\ninstitution = "Bank"\nacctid_last4 = "1111"\n'
                   'last4 = "2222"\nreissued = true\n')
        self.assertTrue(a.header_matches("1111"))
        self.assertTrue(a.header_matches("2222"))
        self.assertFalse(a.header_matches("3333"))

    def test_plain_override_still_refuses_a_header_that_disagrees(self):
        [a] = load('[[account]]\ninstitution = "Bank"\nacctid_last4 = "1111"\nlast4 = "2222"\n')
        self.assertFalse(a.header_matches("1111"))
        self.assertTrue(a.header_matches("2222"))

    def test_reissued_needs_both_numbers_and_a_bool(self):
        with self.assertRaises(accounts.AccountsError):
            load('[[account]]\ninstitution = "Bank"\nacctid_last4 = "1111"\nreissued = true\n')
        with self.assertRaises(accounts.AccountsError):
            load('[[account]]\ninstitution = "Bank"\nacctid_last4 = "1111"\nlast4 = "2222"\n'
                 'reissued = "yes"\n')


if __name__ == "__main__":
    unittest.main()
