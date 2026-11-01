"""The engine: everything an adapter does NOT own.

Adapters identify and extract raw drafts. The engine owns account labels, masking, keys,
dedupe, the reconcile gate, the leak gate, ordering and output, so those rules are identical
for every institution and a contributor cannot weaken them from an adapter.
"""
import hashlib
import re
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from pathlib import Path

from . import SCHEMA, engine_version
from . import accounts as accounts_mod
from . import keys, mask, reconcile
from .dedupe import Deduper
from .drivers import csv_driver, ofx_driver, pdftext_driver
from .model import (AS_OF_BASES, PRIMARY_BALANCE, Check, Exit, PositionDraft, Refusal,
                    StatementDraft)
from .money import as_str, credit_debit
from .readers import pdftext
from .registry import Adapter

MAX_CYCLE_GAP_DAYS = 3  # see chain()
DRIVERS = {"ofx": ofx_driver, "pdftext": pdftext_driver, "csv": csv_driver}

# Output fields the leak gate does not read, each for a stated reason:
# - hex digests: sha256 hex has a ~90% chance of holding a 7+ decimal-digit run by accident,
#   and a digest cannot carry an account number;
# - the institution's own transaction id (entry_ref, and the id segment of a fitid key):
#   numeric FITIDs are routine, and the key bytes are frozen, so masking them is not an option.
EXEMPT_FIELDS = {"statement_id", "previous_statement_id", "position_id", "sha256",
                 "extractor_version", "entry_ref"}


@dataclass
class FileResult:
    path: Path
    sha256: str
    adapter: Adapter | None = None
    repairs: list[str] = field(default_factory=list)
    statements: list[dict] = field(default_factory=list)
    positions: list[dict] = field(default_factory=list)
    transactions: list[dict] = field(default_factory=list)
    refusal: Refusal | None = None
    skipped_by_manifest: bool = False


def sha256_file(path: Path) -> tuple[bytes, str]:
    raw = path.read_bytes()
    return raw, hashlib.sha256(raw).hexdigest()


def candidates(raw: bytes, adapters: list[Adapter], path: Path | None = None) -> list[Adapter]:
    return [a for a in adapters if DRIVERS[a.format].identify(raw, a, path)]


def _account_view(adapter: Adapter, d: StatementDraft, accts) -> tuple[str, str, object]:
    try:
        acct = accounts_mod.find(accts, adapter.institution, d.acctid)
    except accounts_mod.AccountsError as e:
        raise Refusal(Exit.USAGE, str(e)) from None
    if adapter.requires_override and (acct is None or not acct.last4):
        raise Refusal(Exit.UNIDENTIFIED, (
            f"{adapter.id} needs an accounts-file entry with last4 for the account whose file "
            f"id ends {keys.last4_ref(d.acctid)}: the file's id is not the number on screen"))
    if adapter.spec.get("account", {}).get("ref") == "currency":
        # One balance per currency, with no account number of its own (Wise): the ISO code
        # is the account, exactly as the legacy keys spell it.
        ref = d.currency
    else:
        ref = keys.last4_ref(acct.last4) if acct and acct.last4 else keys.last4_ref(d.acctid)
    kind = acct.kind if acct and acct.kind else d.kind
    return ref, kind, acct


def build(path: Path, raw: bytes, sha: str, adapter: Adapter, accts, require: str | None
          ) -> FileResult:
    """One file through one adapter -> records, or a Refusal."""
    drafts, fired = DRIVERS[adapter.format].extract(raw, adapter, path)
    res = FileResult(path, sha, adapter, fired)
    version = engine_version()
    file_label = mask.mask(path.name)
    # Grouped-digit masking only where account numbers are printed grouped: PDF statements.
    # QFX/OFX and CSV print them as unbroken runs (long-digit-run masks those), so their
    # dashed store and reference numbers stay readable, as their legacy extractors showed them.
    grouped = adapter.format == "pdftext"
    scheme = adapter.spec["keys"]["scheme"]
    fallbacks = adapter.spec["keys"].get("fallback", [])
    need = max(reconcile.rank(adapter.minimum), reconcile.rank(require or "structural"))

    proves = bool(adapter.spec.get("reconcile", {}).get("proves", False))
    backend = None
    if adapter.format == "pdftext":
        backend = pdftext.backend_version() if pdftext.is_pdf(raw) else "layout.txt"

    positions = [d for d in drafts if isinstance(d, PositionDraft)]
    statements = [d for d in drafts if isinstance(d, StatementDraft)]
    if len(positions) + len(statements) != len(drafts):
        raise TypeError(f"{adapter.id}: a hook returned something other than drafts")
    if positions and "position" not in adapter.spec:
        raise Refusal(Exit.REFUSED, f"{adapter.id}: emitted a position but declares no "
                      "[position] table (positions are opt-in per adapter)")
    for p in positions:
        res.positions.append(_position(adapter, p, accts, sha, file_label, version, fired,
                                       backend, reconcile.rank(require or "structural")))

    for d in statements:
        ref, kind, acct = _account_view(adapter, d, accts)
        if adapter.spec.get("account", {}).get("verify_last4") and acct and acct.last4:
            # The statement header prints the real account: an override that disagrees with it
            # is a wrong accounts entry, and would key the rows to someone else's account.
            head = d.acctid.strip()[-4:]
            d.checks.append(Check("header_last4", head == acct.last4,
                                  expected=f"••{acct.last4} (accounts file)",
                                  actual=f"••{head} (statement header)"))
        if scheme == keys.NATIVE_ID_TS:
            # Two rows sharing (id, timestamp) would share one key. Identical rows would even
            # pass dedupe as dup_in_run, so refuse the file here instead.
            n_rep = keys.repeated_pairs((t.entry_ref, t.native_ts) for t in d.transactions)
            d.checks.append(Check("native_id_unique", n_rep == 0, expected="0 repeated",
                                  actual=f"{n_rep} repeated (id, timestamp) pairs"))
        d.checks += reconcile.assertions(d, acct)
        failed = [c for c in d.checks if not c.ok]
        sid = hashlib.sha256(f"{sha}|{ref}|{d.index}".encode()).hexdigest()[:16]
        if failed:
            raise Refusal(Exit.REFUSED, f"{ref}: check(s) failed: "
                          + ", ".join(c.name for c in failed),
                          checks=[c.as_dict() for c in failed])
        status = reconcile.status(d.checks, proves)
        if reconcile.rank(status) < need:
            raise Refusal(Exit.REFUSED, f"{ref}: reconcile status {status!r} is below the "
                          f"required {reconcile.STATUSES[need]!r}")
        keyers = {}
        txns = []
        for n, t in enumerate(d.transactions, 1):
            use = scheme
            for fb in fallbacks:
                if re.fullmatch(fb["fitid_pattern"], t.entry_ref or ""):
                    use = fb["scheme"]
                    break
            if use == "fitid":
                key = keys.fitid_key(adapter.institution, ref, t.entry_ref)
            elif use == keys.NATIVE_ID_TS:
                key = keys.native_id_ts_key(adapter.institution, ref, t.entry_ref, t.native_ts)
            elif use == "statement-line/1":
                key = keys.statement_line_key(adapter.institution, ref, d.period_end, n)
            else:
                keyer = keyers.setdefault(use, keys.ContentKeyer(use, adapter.institution, ref))
                key = keyer.key(t.key_date or t.booking_date, t.amount, t.description)
            txns.append({
                "schema": SCHEMA, "record": "transaction",
                "key": key, "key_scheme": use, "statement_id": sid,
                "institution": adapter.institution, "account": ref,
                "booking_date": t.booking_date, "transaction_date": t.transaction_date,
                "amount": as_str(t.amount), "currency": d.currency,
                "credit_debit": credit_debit(t.amount),
                "description": mask.mask(t.description, grouped), "memo": mask.mask(t.memo, grouped),
                "counterparty": mask.mask(t.counterparty, grouped) if t.counterparty else None,
                "source_type": t.source_type, "entry_ref": t.entry_ref,
                "running_balance": as_str(t.running_balance),
                "source": {"file": file_label, "sha256": sha, "locator": t.locator},
            })
        res.statements.append({
            "schema": SCHEMA, "record": "statement", "statement_id": sid,
            "institution": adapter.institution,
            "account": {"ref": ref, "kind": kind, "currency": d.currency},
            "period": {"start": d.period_start, "end": d.period_end},
            "balances": {"opening": as_str(d.opening), "closing": as_str(d.closing),
                         "closing_as_of": d.closing_as_of, "available": as_str(d.available)},
            "source": {"file": file_label, "sha256": sha, "format": adapter.format,
                       "extractor_version": version,
                       "adapter": {"id": adapter.id, "sha256": adapter.sha256},
                       "repairs": fired,
                       **({"text_backend": backend} if backend else {})},
            "reconcile": {"status": status, "checks": [c.as_dict() for c in d.checks]},
            "counts": {"parsed": d.raw_txn_count, "skipped": d.skipped, "emitted": 0,
                       "seen": 0, "dup_in_run": 0},
        })
        res.transactions += txns
    return res


def position_id(institution: str, ref: str, kind: str, as_of: str) -> str:
    """Deterministic: the consumer upserts a snapshot by it. The same account, kind and day
    from any file (a re-download, a second copy) is the same position."""
    return hashlib.sha256(f"{institution}|{ref}|{kind}|{as_of}".encode()).hexdigest()[:16]


def _date_ok(s) -> bool:
    try:
        date.fromisoformat(s)
        return True
    except (TypeError, ValueError):
        return False


def _term(v) -> str:
    return as_str(v) if isinstance(v, Decimal) else str(v)


def _position(adapter: Adapter, p: PositionDraft, accts, sha: str, file_label: str,
              version: str, fired: list[str], backend: str | None, need: int) -> dict:
    """One PositionDraft -> a position record, or a Refusal. A snapshot has no rows to tie, so
    its ceiling is `asserted`: the adapter's `proves` never applies to it, and its `minimum`
    governs statements only."""
    ref, _kind, acct = _account_view(adapter, p, accts)
    if adapter.spec.get("account", {}).get("verify_last4") and acct and acct.last4:
        head = p.acctid.strip()[-4:]
        p.checks.append(Check("header_last4", head == acct.last4,
                              expected=f"••{acct.last4} (accounts file)",
                              actual=f"••{head} (statement header)"))
    missing = [w for w, ok in (
        ("kind", p.kind == adapter.spec["position"]["kind"]),
        ("as_of", _date_ok(p.as_of)),
        ("as_of_basis", p.as_of_basis in AS_OF_BASES),
        (PRIMARY_BALANCE, isinstance(p.balances.get(PRIMARY_BALANCE), Decimal)),
        ("balances", all(isinstance(v, Decimal) for v in p.balances.values())),
    ) if not ok]
    p.checks.insert(0, Check("required_fields", not missing, expected="all present",
                             actual=("missing or malformed: " + ", ".join(missing)) if missing
                             else "all present",
                             note=f"kind, as_of ({p.as_of_basis}), {PRIMARY_BALANCE}"))
    p.checks += reconcile.position_assertions(p, acct)
    failed = [c for c in p.checks if not c.ok]
    if failed:
        raise Refusal(Exit.REFUSED, f"{ref}: position check(s) failed: "
                      + ", ".join(c.name for c in failed),
                      checks=[c.as_dict() for c in failed])
    status = reconcile.status(p.checks, False)
    if reconcile.rank(status) < need:
        raise Refusal(Exit.REFUSED, f"{ref}: position status {status!r} is below the required "
                      f"{reconcile.STATUSES[need]!r} (a snapshot is never proven)")
    return {
        "schema": SCHEMA, "record": "position",
        "position_id": position_id(adapter.institution, ref, p.kind, p.as_of),
        "institution": adapter.institution,
        "account": {"ref": ref, "kind": p.kind, "currency": p.currency},
        "as_of": p.as_of, "as_of_basis": p.as_of_basis,
        "balances": {k: as_str(v) for k, v in sorted(p.balances.items())},
        "terms": {k: _term(v) for k, v in sorted(p.terms.items())},
        "source": {"file": file_label, "sha256": sha, "format": adapter.format,
                   "extractor_version": version,
                   "adapter": {"id": adapter.id, "sha256": adapter.sha256},
                   "repairs": fired,
                   **({"text_backend": backend} if backend else {})},
        "reconcile": {"status": status, "checks": [c.as_dict() for c in p.checks]},
    }


def run_file(path: Path, raw: bytes, sha: str, adapters: list[Adapter], accts,
             require: str | None) -> FileResult:
    """Identify, then fail closed: exactly one claiming adapter must reconcile."""
    claim = candidates(raw, adapters, path)
    if not claim:
        if pdftext.is_pdf(raw) or path.name.endswith(pdftext.LAYOUT_SUFFIX):
            pdftext.text_of(path, raw)  # a scan with no text layer refuses here, by name
        raise Refusal(Exit.UNIDENTIFIED, "no adapter identifies this file")
    ok, errors = [], []
    for a in claim:
        try:
            ok.append(build(path, raw, sha, a, accts, require))
        except Refusal as e:
            errors.append((a, e))
    if len(ok) == 1:
        return ok[0]
    if len(ok) > 1:
        raise Refusal(Exit.UNIDENTIFIED, "ambiguous: several adapters reconcile: "
                      + ", ".join(r.adapter.id for r in ok))
    if len(errors) == 1:
        raise errors[0][1]
    raise Refusal(Exit.REFUSED, "no claiming adapter reconciles: " + "; ".join(
        f"{a.id}: {e.reason}" for a, e in errors))


def _strings(obj, path=""):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k not in EXEMPT_FIELDS:
                yield from _strings(v, f"{path}.{k}" if path else k)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from _strings(v, f"{path}[{i}]")
    elif isinstance(obj, str):
        yield path, obj


def leak_scan(records: list[dict]) -> list[str]:
    """-> 'record#n field' for every leaking string (values are never echoed)."""
    hits = []
    for n, rec in enumerate(records):
        for where, s in _strings(rec):
            if where == "key" and rec.get("key_scheme") == "fitid":
                # institution|••1234|FITID: gate the prefix, exempt the institution's own id.
                s = s.rsplit("|", 1)[0]
            elif where == "key" and rec.get("key_scheme") == keys.NATIVE_ID_TS:
                # institution|CUR|<native id>|<timestamp>: gate all but the institution's id
                # (Wise ids are CARD-/TRANSFER- plus 7+ digits, every one of them).
                parts = s.split("|")
                s = "|".join(parts[:2] + parts[-1:])
            if mask.leaks(s):
                hits.append(f"{rec['record']}#{n} {where}")
    return hits


def order(statements: list[dict], txns: list[dict], positions=()) -> list[dict]:
    """Stable, argv-independent: statements, then positions, then transactions; each by
    institution, account, its own date, then file sha256."""
    positions = sorted(positions, key=lambda p: (
        p["institution"], p["account"]["ref"], p["as_of"], p["source"]["sha256"],
        p["position_id"]))
    statements = sorted(statements, key=lambda s: (
        s["institution"], s["account"]["ref"], s["period"]["start"] or "",
        s["period"]["end"] or "", s["source"]["sha256"], s["statement_id"]))
    txns = sorted(txns, key=lambda t: (
        t["institution"], t["account"], t["booking_date"], t["source"]["sha256"],
        t["source"]["locator"]))
    return statements + positions + txns


def chain(results: list[FileResult]) -> None:
    """chain_across_statements: when one account's statements in this run are back to back,
    the next opening must equal the previous closing. The same period delivered twice must
    carry the same balances. A month missing from the run is not judged.

    "Back to back" is a start 1-3 days after the previous end: statement cycles that end on
    a weekend or holiday leave 2-3 day gaps (measured 2026-10-31 on 28 consecutive real
    Scotiabank hand-overs: 21 x 1 day, 6 x 2, 1 x 3, balances equal across all 28). A
    missing month is a gap of 28+ days, so it can never be judged by mistake."""
    by_acct: dict[tuple, list[dict]] = {}
    for r in results:
        for s in r.statements:
            p, b = s["period"], s["balances"]
            if p["start"] and p["end"] and b["opening"] is not None and b["closing"] is not None:
                by_acct.setdefault((s["institution"], s["account"]["ref"]), []).append(s)
    for (inst, ref), stmts in by_acct.items():
        stmts.sort(key=lambda s: (s["period"]["start"], s["period"]["end"],
                                  s["source"]["sha256"]))
        for prev, nxt in zip(stmts, stmts[1:]):
            same = prev["period"] == nxt["period"]
            if same:
                ok = prev["balances"] == nxt["balances"]
                expected, actual = prev["balances"]["closing"], nxt["balances"]["closing"]
            else:
                gap = (date.fromisoformat(nxt["period"]["start"])
                       - date.fromisoformat(prev["period"]["end"])).days
                if not 1 <= gap <= MAX_CYCLE_GAP_DAYS:
                    continue
                expected, actual = prev["balances"]["closing"], nxt["balances"]["opening"]
                ok = expected == actual
            check = {"name": "chain_across_statements", "ok": ok, "expected": expected,
                     "actual": actual, "previous_statement_id": prev["statement_id"],
                     "note": "same period delivered again" if same else
                     "opening = closing of the statement before"}
            nxt["reconcile"]["checks"].append(check)
            if not ok:
                raise Refusal(Exit.REFUSED, f"{inst} {ref}: statement ending "
                              f"{nxt['period']['end']} does not continue the one ending "
                              f"{prev['period']['end']}", check=check)


def one_source_per_period(results: list[FileResult]) -> None:
    """Two ADAPTERS reading overlapping periods of one account would key the same movements
    twice: their schemes differ (Wise PDF content keys vs Wise CSV native-id-ts/1), so dedupe
    cannot see the overlap. Measured 2026-10-31 on a real September: the PDF's 49 rows match
    the CSV's 49 by (id, date, amount), and a joint run emitted 188 rows instead of 139.
    Refuse the whole run instead. The same adapter twice (overlapping exports) is fine."""
    spans: dict[tuple, list[dict]] = {}
    for r in results:
        for s in r.statements:
            if s["period"]["start"] and s["period"]["end"]:
                spans.setdefault((s["institution"], s["account"]["ref"]), []).append(s)
    for (inst, ref), stmts in spans.items():
        for i, a in enumerate(stmts):
            for b in stmts[i + 1:]:
                ida, idb = a["source"]["adapter"]["id"], b["source"]["adapter"]["id"]
                if ida != idb and a["period"]["start"] <= b["period"]["end"] \
                        and b["period"]["start"] <= a["period"]["end"]:
                    raise Refusal(Exit.REFUSED, f"{inst} {ref}: {ida} and {idb} both cover "
                                  f"{max(a['period']['start'], b['period']['start'])}.."
                                  f"{min(a['period']['end'], b['period']['end'])}; their keys "
                                  "differ, so the overlap would be emitted twice. Pass one "
                                  "source per period")


def _position_payload(p: dict) -> tuple:
    return (p["institution"], p["account"], p["as_of"], p["as_of_basis"], p["balances"],
            p["terms"])


def dedupe_positions(results: list[FileResult]) -> list[dict]:
    """One record per position_id. The same snapshot from two files (a second copy, a
    re-download) is kept once, from the file whose sha256 sorts first. The same id with a
    different payload means two documents disagree about one account on one day: refuse the
    run, never pick one. --seen does not apply: a consumer upserts positions by id."""
    by_id: dict[str, dict] = {}
    for r in results:
        for p in r.positions:
            first = by_id.get(p["position_id"])
            if first is None:
                by_id[p["position_id"]] = p
                continue
            if _position_payload(first) != _position_payload(p):
                check = {"name": "position_collision", "ok": False,
                         "expected": first["source"]["sha256"][:12],
                         "actual": p["source"]["sha256"][:12],
                         "note": "two files state different facts for one position_id"}
                raise Refusal(Exit.REFUSED, f"{p['institution']} {p['account']['ref']}: two "
                              "files disagree about one position (same account, kind and "
                              "as_of)", check=check)
            if p["source"]["sha256"] < first["source"]["sha256"]:
                by_id[p["position_id"]] = p
    return list(by_id.values())


def dedupe(results: list[FileResult], seen: set[str]) -> list[dict]:
    """Apply --seen and in-run dedupe; fill each statement's counts. -> kept transactions."""
    d = Deduper(seen)
    kept = []
    by_sid = {s["statement_id"]: s for r in results for s in r.statements}
    for r in results:
        for t in r.transactions:
            outcome = d.offer(t)
            counts = by_sid[t["statement_id"]]["counts"]
            if outcome == "new":
                kept.append(t)
                counts["emitted"] += 1
            elif outcome == "seen":
                counts["seen"] += 1
            else:
                counts["dup_in_run"] += 1
    return kept
