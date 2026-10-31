"""OFX 1.x (SGML) and 2.x (XML) reader. Stdlib only, MIT.

Written instead of depending on ofxtools (GPL-3.0). Where a value reaches a frozen key, this
reader reproduces ofxtools 0.9.5's text semantics exactly, because historical keys were made
through it:

- element text is stripped, then only `&amp; &lt; &gt; &nbsp; &apos; &quot;` are unescaped;
- a body is decoded by its CHARSET (NONE=utf-8, 1252=cp1252, ISO-8859-1=latin-1); v2 is utf-8;
- DTPOSTED with a [+h:TZ] offset is shifted to UTC before its date is taken (`key_date`).

Unlike ofxtools it never drops an aggregate on an unknown tag and carries on: an unknown or
misplaced tag on the path it reads is an error, because a ledger missing an account is worse
than no sync. Proprietary tags (with a '.', e.g. INTU.BID) are ignored, as ofxtools does.
"""
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from xml.sax import saxutils

# Same token grammar as ofxtools' TreeBuilder: a start tag, optional text or CDATA, an optional
# matching end tag, and tail text (which must be blank).
TOKEN = re.compile(
    r"<(?P<tag>[A-Z0-9./_ ]+?)>"
    r"((<!\[CDATA\[(?P<cdata>.+)\]\]>)|(?P<text>[^<]+))?"
    r"(</(?P<closetag>(?P=tag))>)?"
    r"(?P<tail>[^<]+)?"
)
CODECS = {"NONE": "utf_8", "1252": "cp1252", "ISO-8859-1": "latin_1"}
DT = re.compile(
    r"^(?P<y>\d{4})(?P<m>0[1-9]|1[0-2])(?P<d>0[1-9]|[12]\d|3[01])"
    r"(?:(?P<H>[01]\d|2[0-3])(?P<M>[0-5]\d)(?P<S>[0-5]\d|60)"
    r"(?:(?:\.(?P<ms>\d{3}))?(?:\[(?P<oh>[0-9+-]+)(?:(?:.(?P<om>\d\d))?(?::(?P<tz>.*))?)?\])?)?)?$"
)
ACCTTYPES = {"CHECKING", "SAVINGS", "MONEYMRKT", "CREDITLINE", "CD"}
TRNTYPES = {
    "CREDIT", "DEBIT", "INT", "DIV", "FEE", "SRVCHG", "DEP", "ATM", "POS", "XFER", "CHECK",
    "PAYMENT", "CASH", "DIRECTDEP", "DIRECTDEBIT", "REPEATPMT", "HOLD", "OTHER",
}

# Allowed children, from the OFX 2.x spec aggregates on the path this reader interprets.
# Value: "L" leaf (data element) or "A" aggregate. Aggregates NOT listed as keys here are
# opaque: kept but not validated (other message sets, OFXEXTENSION, IMAGEDATA, ...).
SCHEMA: dict[str, dict[str, str]] = {
    "OFX": {t: "A" for t in (
        "SIGNONMSGSRQV1 SIGNONMSGSRSV1 SIGNUPMSGSRQV1 SIGNUPMSGSRSV1 BANKMSGSRQV1 BANKMSGSRSV1 "
        "CREDITCARDMSGSRQV1 CREDITCARDMSGSRSV1 INVSTMTMSGSRQV1 INVSTMTMSGSRSV1 "
        "INTERXFERMSGSRQV1 INTERXFERMSGSRSV1 WIREXFERMSGSRQV1 WIREXFERMSGSRSV1 BILLPAYMSGSRQV1 "
        "BILLPAYMSGSRSV1 EMAILMSGSRQV1 EMAILMSGSRSV1 SECLISTMSGSRQV1 SECLISTMSGSRSV1 "
        "PRESDIRMSGSRQV1 PRESDIRMSGSRSV1 PRESDLVMSGSRQV1 PRESDLVMSGSRSV1 PROFMSGSRQV1 "
        "PROFMSGSRSV1 LOANMSGSRQV1 LOANMSGSRSV1 TAX1098MSGSRQV1 TAX1098MSGSRSV1 TAX1099MSGSRQV1 "
        "TAX1099MSGSRSV1 TAXW2MSGSRQV1 TAXW2MSGSRSV1 TAX1095MSGSRQV1 TAX1095MSGSRSV1").split()},
    "SIGNONMSGSRSV1": {"SONRS": "A", "PINCHTRNRS": "A", "CHALLENGETRNRS": "A",
                       "MFACHALLENGETRNRS": "A"},
    "SONRS": {"STATUS": "A", "DTSERVER": "L", "USERKEY": "L", "TSKEYEXPIRE": "L",
              "LANGUAGE": "L", "DTPROFUP": "L", "DTACCTUP": "L", "FI": "A", "SESSCOOKIE": "L",
              "ACCESSKEY": "L", "OFXEXTENSION": "A"},
    "STATUS": {"CODE": "L", "SEVERITY": "L", "MESSAGE": "L"},
    "FI": {"ORG": "L", "FID": "L"},
    "BANKMSGSRSV1": {t: "A" for t in (
        "STMTTRNRS STMTENDTRNRS STPCHKTRNRS INTRATRNRS RECINTRATRNRS BANKMAILTRNRS "
        "STPCHKSYNCRS INTRASYNCRS RECINTRASYNCRS BANKMAILSYNCRS").split()},
    "CREDITCARDMSGSRSV1": {"CCSTMTTRNRS": "A", "CCSTMTENDTRNRS": "A"},
    "STMTTRNRS": {"TRNUID": "L", "STATUS": "A", "CLTCOOKIE": "L", "OFXEXTENSION": "A",
                  "STMTRS": "A"},
    "CCSTMTTRNRS": {"TRNUID": "L", "STATUS": "A", "CLTCOOKIE": "L", "OFXEXTENSION": "A",
                    "CCSTMTRS": "A"},
    "STMTRS": {"CURDEF": "L", "BANKACCTFROM": "A", "BANKTRANLIST": "A", "BANKTRANLISTP": "A",
               "LEDGERBAL": "A", "AVAILBAL": "A", "CASHADVBALAMT": "L", "INTRATE": "L",
               "BALLIST": "A", "MKTGINFO": "L"},
    "CCSTMTRS": {"CURDEF": "L", "CCACCTFROM": "A", "BANKTRANLIST": "A", "BANKTRANLISTP": "A",
                 "LEDGERBAL": "A", "AVAILBAL": "A", "CASHADVBALAMT": "L", "INTRATEPURCH": "L",
                 "INTRATECASH": "L", "INTRATEXFER": "L", "REWARDINFO": "A", "BALLIST": "A",
                 "MKTGINFO": "L"},
    "BANKACCTFROM": {"BANKID": "L", "BRANCHID": "L", "ACCTID": "L", "ACCTTYPE": "L",
                     "ACCTKEY": "L"},
    "BANKACCTTO": {"BANKID": "L", "BRANCHID": "L", "ACCTID": "L", "ACCTTYPE": "L",
                   "ACCTKEY": "L"},
    "CCACCTFROM": {"ACCTID": "L", "ACCTKEY": "L"},
    "CCACCTTO": {"ACCTID": "L", "ACCTKEY": "L"},
    "BANKTRANLIST": {"DTSTART": "L", "DTEND": "L", "STMTTRN": "A"},
    "STMTTRN": {"TRNTYPE": "L", "DTPOSTED": "L", "DTUSER": "L", "DTAVAIL": "L", "TRNAMT": "L",
                "FITID": "L", "CORRECTFITID": "L", "CORRECTACTION": "L", "SRVRTID": "L",
                "CHECKNUM": "L", "REFNUM": "L", "SIC": "L", "PAYEEID": "L", "NAME": "L",
                "PAYEE": "A", "EXTDNAME": "L", "BANKACCTTO": "A", "CCACCTTO": "A", "MEMO": "L",
                "IMAGEDATA": "A", "CURRENCY": "A", "ORIGCURRENCY": "A", "INV401KSOURCE": "L"},
    "PAYEE": {t: "L" for t in
              "NAME ADDR1 ADDR2 ADDR3 CITY STATE POSTALCODE COUNTRY PHONE".split()},
    "CURRENCY": {"CURRATE": "L", "CURSYM": "L"},
    "ORIGCURRENCY": {"CURRATE": "L", "CURSYM": "L"},
    "LEDGERBAL": {"BALAMT": "L", "DTASOF": "L"},
    "AVAILBAL": {"BALAMT": "L", "DTASOF": "L"},
    "BALLIST": {"BAL": "A"},
    "BAL": {"NAME": "L", "DESC": "L", "BALTYPE": "L", "VALUE": "L", "DTASOF": "L",
            "CURRENCY": "A"},
    "REWARDINFO": {"NAME": "L", "REWARDBAL": "L", "REWARDEARNED": "L"},
}


class OFXError(ValueError):
    """The file is not OFX this reader can vouch for. Always a refusal, never a skip."""


@dataclass
class Node:
    tag: str
    text: str | None = None
    children: list["Node"] = field(default_factory=list)
    leaf: bool = False

    def get(self, tag: str) -> "Node | None":
        for c in self.children:
            if c.tag == tag:
                return c
        return None

    def all(self, tag: str) -> list["Node"]:
        return [c for c in self.children if c.tag == tag]

    def val(self, tag: str) -> str | None:
        c = self.get(tag)
        return c.text if c is not None and c.leaf else None


@dataclass
class Document:
    version: int
    charset: str
    body: str
    root: Node


def split(raw: bytes) -> tuple[int, str, str]:
    """-> (version, charset, decoded body). Raises OFXError."""
    head = raw.lstrip()[:600]
    if head.startswith(b"<?xml") or b"<?OFX" in head:
        try:
            text = raw.decode("utf_8")
        except UnicodeDecodeError as e:
            raise OFXError(f"OFX 2.x body is not UTF-8: {e.reason}") from None
        i = text.find("<OFX>")
        if i < 0:
            raise OFXError("no <OFX> element")
        return 2, "UTF-8", text[i:]
    if not raw.lstrip().startswith(b"OFXHEADER:"):
        raise OFXError("no OFX header")
    i = raw.find(b"<")
    if i < 0:
        raise OFXError("no OFX body")
    try:
        header = raw[:i].decode("ascii")
    except UnicodeDecodeError:
        raise OFXError("OFX 1.x header is not ASCII") from None
    m = re.search(r"^\s*CHARSET:\s*(\S+)", header, re.M)
    charset = m.group(1) if m else "NONE"
    if charset not in CODECS:
        raise OFXError(f"unsupported CHARSET {charset!r}")
    try:
        return 1, charset, raw[i:].decode(CODECS[charset])
    except UnicodeDecodeError as e:
        raise OFXError(f"body does not decode as CHARSET {charset}: {e.reason}") from None


def _groom(s: str | None) -> str | None:
    s = (s or "").strip()
    return s or None


def _unescape(s: str) -> str:
    return saxutils.unescape(s, {"&nbsp;": " ", "&apos;": "'", "&quot;": '"'})


def build(body: str) -> Node:
    root = Node("#document")
    stack = [root]
    for m in TOKEN.finditer(body):
        tag = m.group("tag")
        if _groom(m.group("tail")):
            raise OFXError(f"text after <{tag}> at offset {m.start()}")
        text = m.group("cdata") or _groom(m.group("text"))
        if tag.startswith("/"):
            if text:
                raise OFXError(f"text after </{tag[1:]}>")
            name = tag[1:]
            if len(stack) == 1 or stack[-1].tag != name:
                open_ = stack[-1].tag if len(stack) > 1 else "nothing"
                raise OFXError(f"</{name}> closes <{open_}>")
            stack.pop()
            continue
        node = Node(tag)
        stack[-1].children.append(node)
        if text:
            node.text, node.leaf = _unescape(text), True
        elif m.group("closetag"):
            pass  # an empty aggregate, closed in place
        else:
            stack.append(node)
    if len(stack) != 1:
        raise OFXError(f"<{stack[-1].tag}> is never closed")
    return root


def validate(node: Node, path: str = "") -> None:
    """Raise on any unknown or misplaced tag along the interpreted path."""
    allowed = SCHEMA.get(node.tag)
    if allowed is None:
        return  # opaque aggregate
    for c in node.children:
        if "." in c.tag:
            continue
        here = f"{path}/{node.tag}"
        kind = allowed.get(c.tag)
        if kind is None:
            raise OFXError(f"unknown tag <{c.tag}> in {here}")
        if kind == "L" and not c.leaf:
            raise OFXError(f"<{c.tag}> in {here} has no value")
        if kind == "A" and c.leaf:
            raise OFXError(f"<{c.tag}> in {here} carries text but is an aggregate")
        validate(c, here)


def parse(raw: bytes) -> Document:
    version, charset, body = split(raw)
    root = build(body)
    ofx = root.all("OFX")
    if len(ofx) != 1 or len(root.children) != 1:
        raise OFXError("expected exactly one <OFX> root")
    validate(ofx[0])
    return Document(version, charset, body, ofx[0])


def parse_dt(text: str | None) -> tuple[str, str] | None:
    """-> (date as written, date after ofxtools' shift to UTC)."""
    if text is None:
        return None
    m = DT.match(text)
    if not m:
        raise OFXError(f"bad OFX datetime {text!r}")
    written = f"{m['y']}-{m['m']}-{m['d']}"
    if m["oh"] is None:
        return written, written
    try:
        hours = int(m["oh"])
    except ValueError:
        raise OFXError(f"unparseable GMT offset in {text!r}") from None
    minutes = int(m["om"] or 0)
    sign = -1 if hours < 0 else 1
    offset = timedelta(minutes=sign * (60 * abs(hours) + minutes))
    local = datetime(int(m["y"]), int(m["m"]), int(m["d"]), int(m["H"] or 0),
                     int(m["M"] or 0), min(int(m["S"] or 0), 59))
    return written, (local - offset).strftime("%Y-%m-%d")


IDENT = re.compile(r"<(ORG|FID|INTU\.BID|CURDEF)>([^<\r\n]*)")


def identifiers(raw: bytes) -> dict[str, list[str]]:
    """ORG, FID, INTU.BID, CURDEF as found, WITHOUT a full parse (identify runs pre-repair).

    Never returns ACCTID, BANKID, BRANCHID or ACCTKEY.
    """
    try:
        _, _, body = split(raw)
    except OFXError:
        return {}
    out: dict[str, list[str]] = {}
    for tag, val in IDENT.findall(body):
        v = _unescape(val.strip())
        if v and v not in out.setdefault(tag, []):
            out[tag].append(v)
    return out
