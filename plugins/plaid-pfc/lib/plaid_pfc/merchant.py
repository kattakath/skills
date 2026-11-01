"""A merchant key from raw statement text: the unit a category decision applies to.

The same algorithm as the beancount plugin's `groups.merchant()`. Both plugins test against one
golden-vector file, `data/merchant-vectors.json`, so the two copies cannot drift apart silently.

The payee (or, when it is empty, the memo's first ";" segment) is upper-cased; masked
references (••1234, ***abc, #12) are removed, then numbers and punctuation; the key is the
first two remaining words of 2+ letters. "TIM HORTONS #1234 KITCHENER" -> "TIM HORTONS".
"""
import re

MASKED = re.compile(r"[A-Z]?••\w*|\*{2,}\w*|#\w+", re.I)
WORD = re.compile(r"[A-Z][A-Z&']+")
NO_TEXT = "(no text)"


def words(payee: str, narration: str = "") -> list[str]:
    text = (payee or "").strip() or (narration or "").split(";")[0]
    return WORD.findall(MASKED.sub(" ", text.upper()))[:2]


def key(payee: str, narration: str = "") -> str:
    return " ".join(words(payee, narration)) or NO_TEXT
