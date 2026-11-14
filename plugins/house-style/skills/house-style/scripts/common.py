"""Shared by gdoc.py and pdf.py: the style, the identity, and Title Case.

The style is ONE file, the Typst package's style.json: the two fonts and five colours every
output uses. The identity comes from a JSON config, so no person's name or account is written
in this plugin:

    {"identity": {"author": "Full Name", "owner": "account@example.com"}}

Config path: --config, else $HOUSE_STYLE_CONFIG, else $XDG_CONFIG_HOME/house-style/config.json
(~/.config when XDG_CONFIG_HOME is unset). A missing file means no identity is set.
"""
import json, os, pathlib, re, sys

SKILL = pathlib.Path(__file__).resolve().parent.parent
PACKAGES = SKILL / "typst"  # a Typst package path: local/house-style/<version>/
STYLE = json.load(open(next(PACKAGES.glob("local/house-style/*/style.json")), encoding="utf-8"))
IDENTITY = {}  # "author" -> the file's author property; "owner" -> the account expected to own a Google Doc


def load_config(path=None):
    """Read the identity from a JSON config. An unknown key is an error, not a silent no-op."""
    if path and not os.path.isfile(path):
        sys.exit(f"no such config: {path}")
    path = path or os.environ.get("HOUSE_STYLE_CONFIG") or os.path.join(
        os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "house-style", "config.json")
    if not os.path.isfile(path):
        return None
    cfg = json.load(open(path, encoding="utf-8"))
    unknown = (set(cfg) - {"identity"}) | (set(cfg.get("identity", {})) - {"author", "owner"})
    if unknown:
        sys.exit(f"{path}: unknown key(s): {', '.join(sorted(unknown))}")
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


def title_case_markdown(lines, bold_lines_as_headings=False):
    """Title Case for headings and table header rows, in place. With bold_lines_as_headings, a
    short bold line standing alone becomes a heading one level below the current one, so it
    stays with the table or list it introduces."""
    in_code, level = False, 1
    for n, l in enumerate(lines):
        if l.startswith("```"): in_code = not in_code
        if in_code: continue
        if l.startswith("#"):
            m = re.match(r"^(#+ )(.*)$", l); lines[n] = m[1] + title_case(m[2]); level = len(m[1]) - 1
        elif l.startswith("|") and n + 1 < len(lines) and re.match(r"^\|[-:| ]+\|$", lines[n + 1]):
            lines[n] = "|" + "|".join(" " + title_case(c.strip()) + " " if c.strip() else c for c in l.strip().strip("|").split("|")) + "|"
        elif bold_lines_as_headings and re.match(r"^\*\*[^*]+\*\*$", l.strip()) and len(l) < 70:
            lines[n] = "#" * (level + 1) + " " + title_case(l.strip().strip("*"))
    return lines
