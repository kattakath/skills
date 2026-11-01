"""Build the pinned data files from Plaid's published taxonomy CSV, and diff against the pin.

Source: https://plaid.com/documents/pfc-taxonomy-all.csv
Columns: PFCv2 Primary, PFCv2 Detailed, PFCv2 Description, PFCv1 Primary, PFCv1 Detailed,
PFCv1 Description. A note row follows the header; one v1 cell joins two names with " / ".
"""
import csv
import hashlib
import io
import urllib.request
from datetime import date

SOURCE = "https://plaid.com/documents/pfc-taxonomy-all.csv"


def fetch(url: str = SOURCE) -> bytes:
    with urllib.request.urlopen(url, timeout=30) as r:   # noqa: S310 (fixed https source)
        return r.read()


def parse(raw: bytes, source: str = SOURCE, fetched: str | None = None) -> tuple[dict, dict]:
    rows = [r for r in csv.reader(io.StringIO(raw.decode("utf-8-sig")))
            if len(r) >= 3 and r[0].isupper() and "_" in r[1]]
    if not rows:
        raise ValueError("no taxonomy rows found: the CSV layout changed")
    detailed, seen = [], set()
    v1_to_v2: dict[str, list[str]] = {}
    for r in rows:
        name = r[1].strip()
        if name not in seen:
            seen.add(name)
            detailed.append({"name": name, "primary": r[0].strip(), "description": r[2].strip()})
        v1cell = (r[4] if len(r) > 4 else "").strip()
        for v1 in filter(None, (x.strip() for x in v1cell.split(" / "))):
            v1_to_v2.setdefault(v1, [])
            if name not in v1_to_v2[v1]:
                v1_to_v2[v1].append(name)
    stamp = {"source": source, "fetched": fetched or date.today().isoformat(),
             "sha256": hashlib.sha256(raw).hexdigest()}
    pinned = {**stamp, "version": "v2",
              "primary": sorted({d["primary"] for d in detailed}),
              "detailed": sorted(detailed, key=lambda d: d["name"])}
    # keep only the entries that are not identity: renames and splits
    cross = {**stamp, "v1_to_v2": {k: v for k, v in sorted(v1_to_v2.items()) if v != [k]}}
    return pinned, cross


def diff(old: dict, new: dict) -> dict:
    o = {d["name"]: d for d in old.get("detailed", [])}
    n = {d["name"]: d for d in new["detailed"]}
    return {"added": sorted(n.keys() - o.keys()), "removed": sorted(o.keys() - n.keys()),
            "redescribed": sorted(k for k in n.keys() & o.keys()
                                  if n[k]["description"] != o[k]["description"])}
