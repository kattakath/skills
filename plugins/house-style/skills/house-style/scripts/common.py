"""Shared by gdoc.py and pdf.py: the style, the identity, and Title Case.

The style is ONE file, ../style.json: the two fonts and the five colours every output uses. A
JSON config may override any of those keys and supplies the identity, so no person's name or
account is written in this plugin:

    {"identity": {"author": "Full Name", "owner": "account@example.com"},
     "style":    {"primary": "0B57D0"}}

Config path: --config, else $HOUSE_STYLE_CONFIG, else $XDG_CONFIG_HOME/house-style/config.json
(~/.config when XDG_CONFIG_HOME is unset). A missing file means the built-in style and no identity.
"""
import json, os, pathlib, re, sys

SKILL = pathlib.Path(__file__).resolve().parent.parent
STYLE = json.load(open(SKILL / "style.json", encoding="utf-8"))
SHARED = frozenset(STYLE)  # the keys a config may override
IDENTITY = {}  # "author" -> the file's author property; "owner" -> the account expected to own a Google Doc


def load_config(path=None):
    """Overlay a JSON config on STYLE and IDENTITY. An unknown key is an error, not a silent no-op."""
    if path and not os.path.isfile(path):
        sys.exit(f"no such config: {path}")
    path = path or os.environ.get("HOUSE_STYLE_CONFIG") or os.path.join(
        os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "house-style", "config.json")
    if not os.path.isfile(path):
        return None
    cfg = json.load(open(path, encoding="utf-8"))
    unknown = (set(cfg) - {"identity", "style"}) | (set(cfg.get("style", {})) - SHARED)
    if unknown:
        sys.exit(f"{path}: unknown key(s): {', '.join(sorted(unknown))}")
    STYLE.update(cfg.get("style", {}))
    IDENTITY.update(cfg.get("identity", {}))
    return path


SMALL = {"a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "by", "with", "from", "as", "at", "vs", "per", "if", "nor", "but"}


def _tc_plain(s):
    words, out = s.split(" "), []
    for i, w in enumerate(words):
        core = w.strip("()[]:;,.\"'*`")
        first = i == 0 or (i == 1 and re.match(r"^[\d.]+$|^Appendix$", words[0])) or (out and out[-1].endswith(":"))
        if not core or not core[0].isalpha() or core[0].isupper() or any(c.isupper() for c in core[1:]) or "_" in core or "`" in w:
            out.append(w)  # a name with its own casing, a code span, or not a word: leave alone
        elif core.lower() in SMALL and not first and i != len(words) - 1:
            out.append(w)
        else:
            j = w.index(core[0]); out.append(w[:j] + w[j].upper() + w[j + 1:])
    return " ".join(out)


def title_case(s):
    """Title Case, leaving link targets alone."""
    links = []
    def stash(m):
        links.append(m.groups()); return f"\x00{len(links) - 1}\x00"
    s = _tc_plain(re.sub(r"\[([^\]]+)\]\(([^)]+)\)", stash, s))
    return re.sub(r"\x00(\d+)\x00", lambda m: f"[{_tc_plain(links[int(m[1])][0])}]({links[int(m[1])][1]})", s)
