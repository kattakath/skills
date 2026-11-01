"""Transaction keys. A key is what a consumer dedupes on, so its bytes are a contract.

FROZEN: the normalisers below reproduce the agentic-ledger extractors of 2026-10-31 byte for
byte, because Keys already stored downstream were made by them. They are pinned twice:
golden vectors (tests/golden/keys.json, produced by running the legacy extractor itself) and a
source hash per function (tests/golden/frozen.json). Never edit one in place. A change is a new
scheme name plus a consumer migration; masking improvements belong in mask.py.
"""
import re
from collections import Counter

from .money import fmt2


def last4_ref(acctid: str) -> str:
    """The account as every key and label shows it: '••' + last four of the stripped id."""
    return "••" + acctid.strip()[-4:]


# --- frozen normalisers ------------------------------------------------------------------

def legacy_qfx_v0(s):
    # FROZEN copy of agentic-ledger qfx_rows.py mask_text (2026-10-31). No whitespace collapse.
    s = re.sub(r"(?<![\d*])\*{2,}[\d*]*(\d{4})\b", r"••\1", (s or "").strip())
    s = re.sub(r"\d{7,}", lambda m: "••" + m.group(0).strip()[-4:], s)
    return re.sub(r"\d{4}\*{4,}(\d{4})", r"••\1", s)


def legacy_collapse_v0(s):
    # FROZEN copy of agentic-ledger pdf_rows_desjardins.py mask_text (2026-10-31).
    s = re.sub(r"\s+", " ", (s or "").strip())
    s = re.sub(r"\d{4} ?\d{2}\*\* ?\*{4} ?(\d{4})", r"••\1", s)
    s = re.sub(r"(?<![\d*])\*{2,}[\d*]*(\d{4})\b", r"••\1", s)
    s = re.sub(r"\d{7,}", lambda m: "••" + m.group(0)[-4:], s)
    return re.sub(r"\d{4}\*{4,}(\d{4})", r"••\1", s)


FROZEN = {
    "content-occurrence/legacy-qfx-v0": legacy_qfx_v0,
    "content-occurrence/legacy-collapse-v0": legacy_collapse_v0,
}

# Schemes this release can build. native-id-ts/1 (Wise) and content-hash/1 arrive with the
# adapters that need them.
SCHEMES = ("fitid", "statement-line/1", *FROZEN)


def fitid_key(institution: str, acct_ref: str, fitid: str) -> str:
    return f"{institution}|{acct_ref}|{fitid}"


def statement_line_key(institution: str, acct_ref: str, period_end: str, n: int) -> str:
    """`Institution|••1234|<statement period end>|<n>`, n = 1-based line in the statement.

    Only sound for a statement that can never be reissued (a closed account): the adapter
    must declare `keys.immutable = true`. Reproduces agentic-ledger
    pdf_rows_scotia_chequing.py (2026-10-31).
    """
    return f"{institution}|{acct_ref}|{period_end}|{n}"


class ContentKeyer:
    """`Institution|••1234|date|amount 2dp|normalised text|n`, n counting identical content.

    One keyer per statement: the legacy counters restarted per account per file.
    """

    def __init__(self, scheme: str, institution: str, acct_ref: str):
        if scheme not in FROZEN:
            raise ValueError(f"unknown content scheme {scheme!r}")
        self.normalise = FROZEN[scheme]
        self.institution = institution
        self.acct_ref = acct_ref
        self.occurrence: Counter = Counter()

    def key(self, date: str, amount, text) -> str:
        content = (date, fmt2(amount), self.normalise(text))
        self.occurrence[content] += 1
        return f"{self.institution}|{self.acct_ref}|{'|'.join(content)}|{self.occurrence[content]}"
