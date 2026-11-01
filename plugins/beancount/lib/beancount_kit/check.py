"""Validate journal text in-process with the same loader bean-check uses."""


def check(text: str) -> tuple[list[str], set]:
    """(error messages, unused pads as (date, account, source) triples)."""
    from beancount import loader  # imported late: `doctor` must run without it
    from beancount.core import data

    _, errors, _ = loader.load_string(text)
    msgs, unused = [], set()
    for e in errors:
        if isinstance(e.entry, data.Pad) and "Unused Pad" in e.message:
            unused.add((e.entry.date.isoformat(), e.entry.account, e.entry.source_account))
        line = (e.source or {}).get("lineno", "?")
        msgs.append(f"line {line}: {e.message}")
    return msgs, unused
