"""Render the journal text. Deterministic: the same inputs give byte-identical output.

Every own-account row is one entry, keyed by its `key` metadata. The other leg is chosen in
this order:
  1. a decision or [categories] override that names an account for the category
  2. a PAIRED own-account transfer leg -> transfers.account, which therefore always nets to
     zero; an UNPAIRED candidate leg -> transfers.external, listed by the report as residue.
     A full rebuild re-pairs every time, so a late partner moves a leg back automatically, and
     net worth never carries an unmatched leg as a phantom asset or debt.
  3. a rule marked EXT, or any TRANSFER_* category -> transfers.external
  4. NEEDS_REVIEW -> Expenses:Uncategorized, flagged "!"
  5. the Plaid default: Income:<Rest> for INCOME, otherwise <Root>:<Primary>:<Rest>

A paired inflow carries the whole clearing amount, so the clearing account nets to zero:
  exact           own +b, transfers -b
  fee             own +b, transfers -a, fee_account +(a-b)
  cross-currency  own +b CURi @@ a CURo, transfers -a CURo   (also in-wallet conversions)

Balance assertions are dated the day AFTER the figure's as-of date, because Beancount checks
a balance at the start of its day. Every assertion is EXACT (`~ 0.00`): Beancount's default
tolerance for a two-decimal balance is one cent (measured on 3.2.3: 0.01 off passes, 0.02
fails), and a bank figure is exact, so a one-cent drift is a missing row that the default
would hide. Each asserted account gets one opening pad from
Equity:Opening-Balances; a position's later snapshots pad from the account's `interest`.
A hole (days no statement covers, between covered stretches) is bridged by a pad from
Equity:Gaps on its first day, labelled with the range: the rows there were never fetched, and
the pad says so instead of hiding the jump in the next balance. A hole whose pad Beancount
reports unused (nothing moved) is dropped like any unused pad.
"""
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

from . import pfc
from .errors import Exit, Refusal
from .rules import NEEDS_REVIEW

OPENING = "Equity:Opening-Balances"
GAPS = "Equity:Gaps"
UNCATEGORIZED = "Expenses:Uncategorized"


INCOME_ROOTS = {"INCOME", "TRANSFER_IN", "LOAN_DISBURSEMENTS"}


def component(s: str) -> str:
    return "-".join(w.capitalize() for w in s.split("_") if w)


def plaid_account(cat: str) -> str:
    primary = next((p for p in pfc.primaries() if cat == p or cat.startswith(p + "_")), None)
    if primary is None:
        raise Refusal(Exit.REFUSED, "category has no Plaid PRIMARY", [cat])
    rest = cat[len(primary) + 1:]
    root = "Income" if primary in INCOME_ROOTS else "Expenses"
    parts = [root] if primary == "INCOME" else [root, component(primary)]
    if rest:
        parts.append(component(rest))
    return ":".join(parts)


def q(s: str) -> str:
    return '"' + (s or "").replace("\\", "\\\\").replace('"', '\\"') + '"'


def day_after(iso: str) -> str:
    return (date.fromisoformat(iso) + timedelta(days=1)).isoformat()


def other_account(x, ledger) -> str:
    tr = ledger.transfers
    if x.cat in ledger.categories:
        return ledger.categories[x.cat]
    if x.cps:
        return tr.account if x.pair else tr.external
    if (x.rule and x.rule["cp"] == "EXT") or x.cat.startswith(("TRANSFER_IN", "TRANSFER_OUT")):
        return tr.external
    if x.cat == NEEDS_REVIEW:
        return UNCATEGORIZED
    return plaid_account(x.cat)


def render(rows, asserts, positions, ledger, skip_pads=frozenset(),
           bridges=(), budgets=(), documents=()) -> tuple[str, dict]:
    own_of, unmapped = {}, set()
    for x in rows:
        a = ledger.account_for(x.inst, x.acct)
        if a is None:
            unmapped.add(f"{x.inst} {x.acct}")
        own_of[x.key] = a
    for s in asserts + positions:
        if ledger.account_for(s.inst, s.acct) is None:
            unmapped.add(f"{s.inst} {s.acct}")
    if unmapped:
        raise Refusal(Exit.REFUSED, "no [[account]] in ledger.toml for", sorted(unmapped))

    first_use: dict[str, str] = {}

    def use(acct: str, iso: str):
        if acct not in first_use or iso < first_use[acct]:
            first_use[acct] = iso

    entries = []   # (date, order, key, text)
    for x in rows:
        own = own_of[x.key].name
        other = other_account(x, ledger)
        flag = "!" if x.cat == NEEDS_REVIEW else "*"
        meta = [("key", x.key), ("category", x.cat)]
        if x.rule and not x.decision:   # provenance: which Category rules row decided this
            p = x.rule["prio"]
            meta.append(("rule", str(int(p)) if p == int(p) else str(p)))
        if x.pair:
            meta += [("transfer", x.pair.key), ("transfer_kind", x.pair_kind)]
        d = x.decision or {}
        for f in ("note", "service", "service_ref"):
            if d.get(f):
                meta.append((f, d[f]))
        meta.append(("source", x.sha[:12]))
        lines = [f"{x.iso} {flag} {q(x.payee)} {q(x.memo)}"]
        lines += [f"  {k}: {q(v)}" for k, v in meta]
        amt = x.amount
        if x.pair and x.amt > 0:   # the inflow leg carries the clearing amount
            o = x.pair
            a_out = -o.amount
            if x.pair_kind in ("cross-currency", "conversion"):
                lines.append(f"  {own}  {amt} {x.cur} @@ {a_out} {o.cur}")
                lines.append(f"  {other}  {-a_out} {o.cur}")
            elif x.pair_kind == "fee":
                lines.append(f"  {own}  {amt} {x.cur}")
                lines.append(f"  {other}  {-a_out} {o.cur}")
                lines.append(f"  {ledger.transfers.fee_account}  {a_out - amt} {x.cur}")
                use(ledger.transfers.fee_account, x.iso)
            else:
                lines.append(f"  {own}  {amt} {x.cur}")
                lines.append(f"  {other}  {-amt} {x.cur}")
        else:
            lines.append(f"  {own}  {amt} {x.cur}")
            lines.append(f"  {other}  {-amt} {x.cur}")
        use(own, x.iso)
        use(other, x.iso)
        entries.append((x.iso, 2, x.key, "\n".join(lines)))

    # Balance assertions: statements and screen figures, then positions (with their pads).
    seen = set()
    asserted_first: dict[str, str] = {}
    for s in sorted(asserts, key=lambda s: (s.as_of, s.inst, s.acct, s.origin, s.amount)):
        a = ledger.account_for(s.inst, s.acct)
        if not a.asserts:
            continue
        on = day_after(s.as_of)
        k = (a.name, on, s.amount, s.cur)
        if k in seen:
            continue
        seen.add(k)
        entries.append((on, 3, a.name, f"{on} balance {a.name}  {s.amount} ~ 0.00 {s.cur}\n"
                                        f"  origin: {q(s.origin)}"))
        asserted_first[a.name] = min(asserted_first.get(a.name, on), on)
        use(a.name, s.as_of)

    by_acct = defaultdict(list)
    for s in positions:
        by_acct[ledger.account_for(s.inst, s.acct).name].append(s)
    pads = []   # (date, account, source)
    for name, snaps in sorted(by_acct.items()):
        a = next(a for a in ledger.accounts if a.name == name)
        if not a.asserts:
            continue
        snaps = sorted({(s.as_of, s.amount, s.cur) for s in snaps})
        for i, (as_of, amount, cur) in enumerate(snaps):
            on = day_after(as_of)
            if i > 0 or name in asserted_first:
                if a.interest:
                    pads.append((as_of, name, a.interest))
                    use(a.interest, as_of)
            entries.append((on, 3, name, f"{on} balance {name}  {amount} ~ 0.00 {cur}\n"
                                         f"  origin: \"position\""))
            asserted_first[name] = min(asserted_first.get(name, on), on)
            use(name, as_of)

    for d_, acct, period, amt, cur in budgets:
        entries.append((d_, 4, acct, f"{d_} custom \"budget\" {acct} {q(period)} {amt} {cur}"))
        use(acct, d_)
    n_docs = 0
    for acct, as_of, path in documents:
        if acct in first_use and as_of >= first_use[acct]:
            entries.append((as_of, 5, acct, f"{as_of} document {acct} {q(path)}"))
            n_docs += 1

    for g in ledger.gaps:
        pads.append((g.date, g.account, GAPS))
        use(GAPS, g.date)
        use(g.account, g.date)
    note = {}
    for h in bridges:
        a = ledger.account_for(*h["account"])
        if a is None or not a.asserts or a.name not in asserted_first:
            continue
        on = day_after(h["after"])
        p = (on, a.name, GAPS)
        if p not in note:
            pads.append(p)
            last = (date.fromisoformat(h["before"]) - timedelta(days=1)).isoformat()
            note[p] = f"not recorded: {on} to {last} ({h['days']} days)"
            use(GAPS, on)
            use(a.name, on)

    # Opening balances: one pad per asserted account, dated its open date.
    opens = {}
    for name, first in first_use.items():
        own = next((a for a in ledger.accounts if a.name == name), None)
        opens[name] = own.open if own and own.open and own.open < first else first
    for name in sorted(asserted_first):
        # opens[name] <= the first figure's as-of date < its assertion date, so this pad
        # always precedes the first balance it fills.
        pads.append((opens[name], name, OPENING))
    used_opening = [d_ for d_, _, src in pads if src == OPENING and (d_, _, src) not in skip_pads]
    if used_opening:
        opens[OPENING] = min(used_opening)
    pads = [p for p in pads if p not in skip_pads]
    for d_, acct, src in pads:
        meta = f"\n  gap: {q(note[(d_, acct, src)])}" if (d_, acct, src) in note else ""
        entries.append((d_, 1, acct, f"{d_} pad {acct} {src}{meta}"))

    earliest = min(opens.values()) if opens else None
    head = [f"; Generated by beancount-kit. DO NOT EDIT: rebuild from the inputs instead.",
            f"option \"title\" {q(ledger.title)}",
            f"option \"operating_currency\" {q(ledger.operating_currency)}", ""]
    if earliest:
        head += [f"{earliest} custom \"fava-option\" {q(k)} {q(v)}"
                 for k, v in sorted(ledger.fava_options.items())]
        head += [f"{earliest} query {q(n)} {q(s)}" for n, s in ledger.queries]
        if ledger.fava_options or ledger.queries:
            head.append("")
    opn = []
    for name in sorted(opens):
        own = next((a for a in ledger.accounts if a.name == name), None)
        d_ = opens[name] if own else earliest
        opn.append(f"{d_} open {name}")
    closes = [f"{a.close} close {a.name}" for a in sorted(ledger.accounts, key=lambda a: a.name)
              if a.close and a.name in opens]
    body = [t for *_, t in sorted(entries, key=lambda e: e[:3])]
    text = "\n".join(head + opn + [""] + closes + ([""] if closes else []) +
                     "\n\n".join(body).split("\n")) + "\n"
    residue = [x.key for x in rows if x.cps and not x.pair]
    return text, {"entries": len(rows), "assertions": sum(1 for e in entries if e[1] == 3),
                  "pads": len(pads), "transfer_residue": residue,
                  "budgets": len(budgets), "documents": n_docs, "queries": len(ledger.queries),
                  "bridges": [f"{a} {note[(d_, a, s)]}" for d_, a, s in pads
                              if (d_, a, s) in note]}
