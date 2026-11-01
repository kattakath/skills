from enum import IntEnum


class Exit(IntEnum):
    OK = 0
    BUG = 1
    USAGE = 2     # bad arguments, unreadable input, wrong schema
    REFUSED = 3   # a check failed: bean-check errors, unmapped account, key conflict


class Refusal(Exception):
    """Fail closed: nothing is written."""

    def __init__(self, code: Exit, reason: str, items=()):
        super().__init__(reason)
        self.code = Exit(code)
        self.reason = reason
        self.items = list(items)
