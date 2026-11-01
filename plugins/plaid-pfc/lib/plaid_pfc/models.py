"""Standard I/O records and their JSON Schema, stdlib only (enum + dataclasses).

The category field is the pinned list as an enum, so a record, a CLI and an LLM's structured
output all accept exactly the same values. Pydantic would add little here: the one hard
constraint is "one of these names", which a JSON Schema enum states directly.
"""
import enum
from dataclasses import MISSING, asdict, dataclass, field, fields

from . import taxonomy

Category = enum.Enum("Category", {n: n for n in [*taxonomy.names(), taxonomy.REVIEW_MARKER]}, type=str)

EVIDENCE_SOURCES = ("rule", "history", "mail", "context", "web", "enrich")
SCHEMA_URI = "https://json-schema.org/draft/2020-12/schema"


class Invalid(ValueError):
    pass


@dataclass
class Txn:
    key: str
    date: str            # ISO date
    amount: str          # decimal as text, in the statement's sign
    currency: str
    description: str
    account: str = ""    # a consumer label, e.g. last four only


@dataclass
class Evidence:
    source: str
    ref: str             # a rule id, a history Key, a mail message id or a URL
    summary: str = ""
    weight: float = 0.0


@dataclass
class Suggestion:
    key: str
    category: str
    confidence: float
    method: str
    evidence: list[Evidence] = field(default_factory=list)

    def validate(self) -> "Suggestion":
        if not taxonomy.is_valid(self.category):
            raise Invalid(f"category {self.category!r} is not a pinned PFC v2 name")
        if not 0.0 <= float(self.confidence) <= 1.0:
            raise Invalid("confidence must be within 0..1")
        for e in self.evidence:
            if e.source not in EVIDENCE_SOURCES:
                raise Invalid(f"evidence source {e.source!r} not in {EVIDENCE_SOURCES}")
        return self

    @classmethod
    def from_dict(cls, d: dict) -> "Suggestion":
        try:
            ev = [Evidence(**e) for e in d.get("evidence", [])]
            return cls(key=d["key"], category=d["category"], confidence=float(d["confidence"]),
                       method=d["method"], evidence=ev).validate()
        except (KeyError, TypeError, ValueError) as e:
            raise Invalid(f"not a Suggestion: {e}") from None

    def to_dict(self) -> dict:
        return asdict(self)


MODELS = {"txn": Txn, "evidence": Evidence, "suggestion": Suggestion}
_JSON_TYPE = {str: "string", float: "number", int: "integer"}


def _property(cls, f) -> dict:
    if f.name == "category":
        return schema("category", root=False)
    if f.name == "evidence":
        return {"type": "array", "items": schema("evidence", root=False)}
    if cls is Evidence and f.name == "source":
        return {"type": "string", "enum": list(EVIDENCE_SOURCES)}
    p = {"type": _JSON_TYPE[f.type]}
    if cls is Suggestion and f.name == "confidence":
        p.update(minimum=0, maximum=1)
    return p


def schema(model: str, root: bool = True) -> dict:
    """JSON Schema (draft 2020-12) for one model: category, txn, evidence or suggestion."""
    if model == "category":
        s = {"type": "string", "enum": [c.value for c in Category]}
    else:
        cls = MODELS[model]
        s = {"type": "object",
             "properties": {f.name: _property(cls, f) for f in fields(cls)},
             "required": [f.name for f in fields(cls)
                          if f.default is MISSING and f.default_factory is MISSING],
             "additionalProperties": False}
    return {"$schema": SCHEMA_URI, **s} if root else s
