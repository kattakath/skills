"""`beancount-kit metrics`: RATIOS and COUNTS from a built journal, never an amount.

Made for an observability push (nix-config ADR-011 step 9): the operator's money stays in
the journal, and only these leave it. Every value is a ratio, a count or an age in days, so
a leaked series says how well the ledger is kept, not what it holds.

  finance_savings_rate{window}         (income - expenses) / income, operating currency,
                                       window = last_month | last_3_months (complete months)
  finance_budget_used_ratio            month-to-date spend / month budget, over all budgets
  finance_month_elapsed_ratio          how far through the month `today` is (the pace line)
  finance_budgets{state}               count of budgets: total | over (spend > budget)
  finance_import_age_days{stat}        days since an open balance-sheet account's newest
                                       posting: newest | oldest (the freshest and stalest)
  finance_import_stale_accounts        open balance-sheet accounts older than --stale-days
  finance_review_backlog               transactions still flagged `!`
  finance_journal_errors               loader errors (0 = the journal checks)

Account and institution NAMES never appear: staleness is reported as counts and extremes.
Budgets follow Fava's `custom "budget"` semantics: the newest directive per account on or
before `today` applies, and a weekly/quarterly/yearly/daily amount is scaled to the month.
"""
import base64
import calendar
import datetime as dt
import json
import os
import time
import urllib.request
from collections import defaultdict
from decimal import Decimal

MONTHLY = {"monthly": Decimal(1), "yearly": Decimal(1) / 12, "quarterly": Decimal(1) / 3,
           "weekly": Decimal(52) / 12}


def _month_start(d: dt.date, back: int = 0) -> dt.date:
    y, m = d.year, d.month - back
    while m <= 0:
        m, y = m + 12, y - 1
    return dt.date(y, m, 1)


def _sum(entries, prefix, cur, start, end):
    from beancount.core import data
    total = Decimal(0)
    for e in entries:
        if isinstance(e, data.Transaction) and start <= e.date < end:
            for p in e.postings:
                if p.account.startswith(prefix) and p.units and p.units.currency == cur:
                    total += p.units.number
    return total


def _savings(entries, cur, start, end):
    income = -_sum(entries, "Income", cur, start, end)
    if income <= 0:
        return None
    return float((income - _sum(entries, "Expenses", cur, start, end)) / income)


def compute(journal: str, today: dt.date | None = None, stale_days: int = 35) -> list[tuple[str, float, dict]]:
    from beancount import loader
    from beancount.core import data

    today = today or dt.date.today()
    entries, errors, options = loader.load_file(journal)
    cur = (options.get("operating_currency") or ["CAD"])[0]
    out = [("finance_journal_errors", float(len(errors)), {})]

    this_month = _month_start(today)
    for window, back in (("last_month", 1), ("last_3_months", 3)):
        rate = _savings(entries, cur, _month_start(today, back), this_month)
        if rate is not None:
            out.append(("finance_savings_rate", rate, {"window": window}))

    # Budgets: newest directive per account on or before today.
    latest = {}
    for e in entries:
        if isinstance(e, data.Custom) and e.type == "budget" and e.date <= today and len(e.values) >= 3:
            acct, period, amount = (v.value for v in e.values[:3])
            if getattr(amount, "currency", cur) == cur:
                latest[acct] = (period, amount.number if hasattr(amount, "number") else Decimal(amount))
    days = calendar.monthrange(today.year, today.month)[1]
    nxt = dt.date(today.year + (today.month == 12), today.month % 12 + 1, 1)
    budget_total = spent_total = Decimal(0)
    over = 0
    for acct, (period, amount) in latest.items():
        scale = Decimal(days) if period == "daily" else MONTHLY.get(period)
        if scale is None:
            continue
        month_budget = amount * scale
        spent = _sum(entries, acct, cur, this_month, nxt)
        budget_total += month_budget
        spent_total += spent
        over += spent > month_budget
    out.append(("finance_budgets", float(len(latest)), {"state": "total"}))
    out.append(("finance_budgets", float(over), {"state": "over"}))
    if budget_total > 0:
        out.append(("finance_budget_used_ratio", float(spent_total / budget_total), {}))
    out.append(("finance_month_elapsed_ratio", today.day / days, {}))

    # Import freshness over OPEN balance-sheet accounts.
    closed = {e.account for e in entries if isinstance(e, data.Close) and e.date <= today}
    newest = defaultdict(lambda: None)
    review = 0
    for e in entries:
        if isinstance(e, data.Transaction):
            review += e.flag == "!"
            for p in e.postings:
                if p.account.split(":")[0] in ("Assets", "Liabilities") and p.account not in closed:
                    if newest[p.account] is None or e.date > newest[p.account]:
                        newest[p.account] = e.date
    ages = [(today - d).days for d in newest.values() if d]
    if ages:
        out.append(("finance_import_age_days", float(min(ages)), {"stat": "newest"}))
        out.append(("finance_import_age_days", float(max(ages)), {"stat": "oldest"}))
    out.append(("finance_import_stale_accounts", float(sum(a > stale_days for a in ages)), {}))
    out.append(("finance_review_backlog", float(review), {}))
    return out


def push(points, env=os.environ) -> int:
    """OTLP/HTTP JSON to $BEANCOUNT_KIT_OTLP_ENDPOINT (…/otlp) with basic auth."""
    now = str(time.time_ns())
    by_name = defaultdict(list)
    for name, value, attrs in points:
        by_name[name].append({"asDouble": value, "timeUnixNano": now,
                              "attributes": [{"key": k, "value": {"stringValue": v}} for k, v in attrs.items()]})
    body = {"resourceMetrics": [{
        "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "beancount-kit"}}]},
        "scopeMetrics": [{"metrics": [{"name": n, "gauge": {"dataPoints": d}} for n, d in by_name.items()]}]}]}
    auth = base64.b64encode(f"{env['BEANCOUNT_KIT_OTLP_INSTANCE']}:{env['BEANCOUNT_KIT_OTLP_TOKEN']}".encode()).decode()
    req = urllib.request.Request(f"{env['BEANCOUNT_KIT_OTLP_ENDPOINT']}/v1/metrics", data=json.dumps(body).encode(),
                                 method="POST", headers={"Content-Type": "application/json",
                                                         "Authorization": f"Basic {auth}"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.status
