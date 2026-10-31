"""The engine: everything an adapter does NOT own.

Adapters identify and extract raw drafts. The engine owns account labels, masking, keys,
dedupe, the reconcile gate, the leak gate, ordering and output, so those rules are identical
for every institution and a contributor cannot weaken them from an adapter.
"""
import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path

from . import SCHEMA, engine_version
from . import accounts as accounts_mod
from . import keys, mask, reconcile
from .dedupe import Deduper
from .drivers import ofx_driver
from .model import Exit, Refusal, StatementDraft
from .money import as_str, credit_debit
from .registry import Adapter

DRIVERS = {"ofx": ofx_driver}

# Output fields the leak gate does not read, each for a stated reason:
# - hex digests: sha256 hex has a ~90% chance of holding a 7+ decimal-digit run by accident,
#   and a digest cannot carry an account number;
# - the institution's own transaction id (entry_ref, and the id segment of a fitid key):
#   numeric FITIDs are routine, and the key bytes are frozen, so masking them is not an option.
EXEMPT_FIELDS = {"statement_id", "sha256", "extractor_version", "entry_ref"}


@dataclass
class FileResult:
    path: Path
    sha256: str
    adapter: Adapter | None = None
    repairs: list[str] = field(default_factory=list)
    statements: list[dict] = field(default_factory=list)
    transactions: list[dict] = field(default_factory=list)
    refusal: Refusal | None = None
    skipped_by_manifest: bool = False


def sha256_file(path: Path) -> tuple[bytes, str]:
    raw = path.read_bytes()
    return raw, hashlib.sha256(raw).hexdigest()


def candidates(raw: bytes, adapters: list[Adapter]) -> list[Adapter]:
    return [a for a in adapters if DRIVERS[a.format].identify(raw, a.spec)]


def _account_view(adapter: Adapter, d: StatementDraft, accts) -> tuple[str, str, object]:
    try:
        acct = accounts_mod.find(accts, adapter.institution, d.acctid)
    except accounts_mod.AccountsError as e:
        raise Refusal(Exit.USAGE, str(e)) from None
    if adapter.requires_override and (acct is None or not acct.last4):
        raise Refusal(Exit.UNIDENTIFIED, (
            f"{adapter.id} needs an accounts-file entry with last4 for the account whose file "
            f"id ends {keys.last4_ref(d.acctid)}: the file's id is not the number on screen"))
    ref = keys.last4_ref(acct.last4) if acct and acct.last4 else keys.last4_ref(d.acctid)
    kind = acct.kind if acct and acct.kind else d.kind
    return ref, kind, acct


def build(path: Path, raw: bytes, sha: str, adapter: Adapter, accts, require: str | None
          ) -> FileResult:
    """One file through one adapter -> records, or a Refusal."""
    drafts, fired = DRIVERS[adapter.format].extract(raw, adapter.spec)
    res = FileResult(path, sha, adapter, fired)
    version = engine_version()
    file_label = mask.mask(path.name)
    scheme = adapter.spec["keys"]["scheme"]
    fallbacks = adapter.spec["keys"].get("fallback", [])
    need = max(reconcile.rank(adapter.minimum), reconcile.rank(require or "structural"))

    for d in drafts:
        ref, kind, acct = _account_view(adapter, d, accts)
        d.checks += reconcile.assertions(d, acct)
        failed = [c for c in d.checks if not c.ok]
        sid = hashlib.sha256(f"{sha}|{ref}|{d.index}".encode()).hexdigest()[:16]
        if failed:
            raise Refusal(Exit.REFUSED, f"{ref}: check(s) failed: "
                          + ", ".join(c.name for c in failed),
                          checks=[c.as_dict() for c in failed])
        status = reconcile.status(d.checks)
        if reconcile.rank(status) < need:
            raise Refusal(Exit.REFUSED, f"{ref}: reconcile status {status!r} is below the "
                          f"required {reconcile.STATUSES[need]!r}")
        keyers = {}
        txns = []
        for t in d.transactions:
            use = scheme
            for fb in fallbacks:
                if re.fullmatch(fb["fitid_pattern"], t.entry_ref or ""):
                    use = fb["scheme"]
                    break
            if use == "fitid":
                key = keys.fitid_key(adapter.institution, ref, t.entry_ref)
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
                "description": mask.mask(t.description), "memo": mask.mask(t.memo),
                "counterparty": mask.mask(t.counterparty) if t.counterparty else None,
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
                       "repairs": fired},
            "reconcile": {"status": status, "checks": [c.as_dict() for c in d.checks]},
            "counts": {"parsed": d.raw_txn_count, "skipped": d.skipped, "emitted": 0,
                       "seen": 0, "dup_in_run": 0},
        })
        res.transactions += txns
    return res


def run_file(path: Path, raw: bytes, sha: str, adapters: list[Adapter], accts,
             require: str | None) -> FileResult:
    """Identify, then fail closed: exactly one claiming adapter must reconcile."""
    claim = candidates(raw, adapters)
    if not claim:
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
            if mask.leaks(s):
                hits.append(f"{rec['record']}#{n} {where}")
    return hits


def order(statements: list[dict], txns: list[dict]) -> list[dict]:
    """Stable, argv-independent: account, booking date, file sha256, locator."""
    statements = sorted(statements, key=lambda s: (
        s["institution"], s["account"]["ref"], s["period"]["start"] or "",
        s["period"]["end"] or "", s["source"]["sha256"], s["statement_id"]))
    txns = sorted(txns, key=lambda t: (
        t["institution"], t["account"], t["booking_date"], t["source"]["sha256"],
        t["source"]["locator"]))
    return statements + txns


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
