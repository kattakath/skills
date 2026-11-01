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


def content_v1(s):
    # FROZEN 2026-10-31 for statements with no institution id (PDF). Collapse whitespace,
    # then keep only the last four of anything account-shaped, including space/dash-grouped
    # numbers (real Scotiabank payees: "ddddd ddddd dd"), dates excepted. A frozen copy of
    # mask.py's rules of that day: mask.py may improve, this may not.
    s = re.sub(r"\s+", " ", (s or "").strip())
    s = re.sub(r"\d{4} ?\d{2}\*\* ?\*{4} ?(\d{4})", r"••\1", s)
    s = re.sub(r"(?<![\d*])\*{2,}[\d*]*(\d{4})\b", r"••\1", s)
    s = re.sub(r"\d{4}\*{4,}(\d{4})", r"••\1", s)

    def grouped(m):
        text = m.group(0)
        digits = re.sub(r"\D", "", text)
        if len(digits) < 7 or re.fullmatch(
                r"\d{4}[-/ ]\d{2}[-/ ]\d{2}|\d{2}[-/ ]\d{2}[-/ ]\d{4}|\d{2}[-/ ]\d{2}[-/ ]\d{2}", text):
            return text
        return "••" + digits[-4:]

    s = re.sub(r"(?<![\d•])\d+(?:[ -]\d+)+(?!\d)", grouped, s)
    return re.sub(r"\d{7,}", lambda m: "••" + m.group(0)[-4:], s)


FROZEN = {
    "content-occurrence/legacy-qfx-v0": legacy_qfx_v0,
    "content-occurrence/legacy-collapse-v0": legacy_collapse_v0,
    "content-occurrence/1": content_v1,
}

# Schemes this release can build. content-hash/1 arrives with the adapter that needs it.
NATIVE_ID_TS = "native-id-ts/1"
SCHEMES = ("fitid", "statement-line/1", NATIVE_ID_TS, *FROZEN)


def fitid_key(institution: str, acct_ref: str, fitid: str) -> str:
    return f"{institution}|{acct_ref}|{fitid}"


def statement_line_key(institution: str, acct_ref: str, period_end: str, n: int) -> str:
    """`Institution|••1234|<statement period end>|<n>`, n = 1-based line in the statement.

    Only sound for a statement that can never be reissued (a closed account): the adapter
    must declare `keys.immutable = true`. Reproduces agentic-ledger
    pdf_rows_scotia_chequing.py (2026-10-31).
    """
    return f"{institution}|{acct_ref}|{period_end}|{n}"


def native_id_ts_key(institution: str, acct_ref: str, native_id: str, ts: str) -> str:
    """`Institution|<CUR>|<native id>|<timestamp as printed>`.

    Wise reuses one id for several balance movements (a card charge and its refund or
    reversal; a top-up and its reversal), so the id alone is not unique; the printed timestamp,
    to the millisecond, separates them. Reproduces agentic-ledger wise_rows.py (2026-10-31)
    byte for byte: the account segment is the balance's ISO currency, both values are the raw
    cells, never reformatted. A file in which an (id, timestamp) pair repeats is refused
    (`native_id_unique`), because two rows would share one key.
    """
    return f"{institution}|{acct_ref}|{native_id}|{ts}"


def repeated_pairs(pairs) -> int:
    """How many distinct (id, timestamp) pairs occur more than once."""
    return sum(1 for n in Counter(pairs).values() if n > 1)


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
