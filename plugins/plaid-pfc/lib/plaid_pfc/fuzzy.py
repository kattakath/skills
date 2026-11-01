"""A fuzzy fallback for merchants with no exact history: character-trigram similarity.

Used only when the exact merchant key has no votes. Each labelled row becomes a vector of
character trigrams over its cleaned payee words (all of them, not just the two-word key),
weighted by inverse document frequency, so a trigram every row shares (a city, "PAYPAL")
counts for little and a distinctive one counts for a lot. The nearest rows (cosine) vote with
their label weight times their similarity.

Confidence = the top category's share of the neighbour vote x the best similarity. A weak
match therefore never looks certain, and `eval` can show precision at each threshold.
Stdlib only: an inverted index over trigrams keeps it fast enough for a personal ledger
(thousands of rows), not for millions.
"""
import math
import re
from collections import Counter, defaultdict

from . import merchant

K = 5              # neighbours that vote
MIN_SIM = 0.35     # below this a neighbour is noise, not a match


def tokens(payee: str, memo: str = "") -> list[str]:
    text = (payee or "").strip() or (memo or "").split(";")[0]
    return merchant.WORD.findall(merchant.MASKED.sub(" ", text.upper()))


def trigrams(words: list[str]) -> Counter:
    c = Counter()
    for w in words:
        w = f" {w} "
        c.update(w[i:i + 3] for i in range(len(w) - 2))
    return c


class FuzzyIndex:
    def __init__(self, labelled):
        """labelled: (history_key, payee, memo, category, weight) for rows with weight > 0."""
        self.rows = []
        df = Counter()
        grams = []
        for key, payee, memo, cat, w in labelled:
            g = trigrams(tokens(payee, memo))
            if not g:
                continue
            grams.append((key, cat, w, g))
            df.update(g.keys())
        n = max(len(grams), 1)
        self.idf = {t: math.log((1 + n) / (1 + d)) + 1.0 for t, d in df.items()}
        self.post = defaultdict(list)
        for key, cat, w, g in grams:
            vec = {t: c * self.idf[t] for t, c in g.items()}
            norm = math.sqrt(sum(v * v for v in vec.values())) or 1.0
            i = len(self.rows)
            self.rows.append((key, cat, w, {t: v / norm for t, v in vec.items()}))
            for t in vec:
                self.post[t].append(i)

    def neighbours(self, payee: str, memo: str = "") -> list[tuple[float, str, str, float]]:
        g = trigrams(tokens(payee, memo))
        vec = {t: c * self.idf.get(t, 0.0) for t, c in g.items() if t in self.idf}
        norm = math.sqrt(sum(v * v for v in vec.values()))
        if not norm:
            return []
        q = {t: v / norm for t, v in vec.items()}
        scores = defaultdict(float)
        for t, v in q.items():
            for i in self.post.get(t, ()):
                scores[i] += v * self.rows[i][3][t]
        best = sorted(scores.items(), key=lambda kv: -kv[1])[:K]
        return [(round(s, 4), self.rows[i][0], self.rows[i][1], self.rows[i][2])
                for i, s in best if s >= MIN_SIM]

    def vote(self, payee: str, memo: str = ""):
        """(category, confidence, [(sim, history_key)]) or None."""
        nb = self.neighbours(payee, memo)
        if not nb:
            return None
        tally = Counter()
        for sim, _key, cat, w in nb:
            tally[cat] += sim * w
        cat, top = tally.most_common(1)[0]
        conf = (top / sum(tally.values())) * nb[0][0]
        return cat, round(conf, 4), [(s, k) for s, k, c, _ in nb if c == cat][:3]
