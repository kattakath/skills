#!/usr/bin/env python3
"""Markdown -> a .docx in the Google Docs house style, ready for Drive to convert into a Google Doc.

    house_style.py [--config FILE] <in.md> <out.docx>

Every style decision is data; nothing is left to a prompt. STYLE below holds the built-in defaults.
A JSON config overrides them and supplies the identity, so no person's name or account is written
in this file:

    {"identity": {"author": "Full Name", "owner": "account@example.com"},
     "style":    {"primary": "0B57D0", "font": "Google Sans"}}

Config path: --config, else $GDOC_HOUSE_STYLE_CONFIG, else $XDG_CONFIG_HOME/gdoc-house-style/config.json
(~/.config when XDG_CONFIG_HOME is unset). A missing file means defaults and no author. Pipeline: pandoc writes
the document through a reference template this script generates, then python-docx applies what a
template cannot express (table formatting, diagram centring, blank lines, Title Case).
Requires: pandoc, python-docx.
"""
import json, os, re, subprocess, sys, tempfile, pathlib
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor

STYLE = {
    "font": "Google Sans",
    "mono": "JetBrains Mono",        # has every box-drawing and arrow glyph in Docs; Consolas does not
    "primary": "0B57D0",             # Material blue, as Google uses it
    "tint": "E8F0FE",                # table title row / title column
    "border": "C4C7C5",              # neutral outline-variant
    "text": "1F1F1F",
    "body_pt": 10, "cell_pt": 9, "mono_pt": 8, "mono_advance": 0.6,   # advance = em fraction per character
    "line": 1.15,
    # space above / below in points
    "title": (26, 0, 10), "h2": (16, 18, 6), "h3": (12, 14, 4), "h4": (10, 10, 3),
    "para_after": 8, "list_after": 3,
    "page_width_pt": 612, "margin_pt": 72,
}
IDENTITY = {}        # "author" -> the document's author property; "owner" -> the account expected to own the Doc


def load_config(path=None):
    """Overlay a JSON config on STYLE and IDENTITY. Unknown style keys are an error, not a silent no-op."""
    path = path or os.environ.get("GDOC_HOUSE_STYLE_CONFIG") or os.path.join(
        os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "gdoc-house-style", "config.json")
    if not os.path.isfile(path):
        return None
    cfg = json.load(open(path, encoding="utf-8"))
    unknown = set(cfg.get("style", {})) - set(STYLE)
    if unknown:
        sys.exit(f"{path}: unknown style key(s): {', '.join(sorted(unknown))}")
    for k, v in cfg.get("style", {}).items():
        STYLE[k] = tuple(v) if isinstance(v, list) else v
    IDENTITY.update(cfg.get("identity", {}))
    return path


SMALL = {"a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "by", "with", "from", "as", "at", "vs", "per", "if", "nor", "but"}


# ── Title Case ────────────────────────────────────────────────────────────────────────────────
def _tc_plain(s):
    words, out = s.split(" "), []
    for i, w in enumerate(words):
        core = w.strip("()[]:;,.\"'*`")
        first = i == 0 or (i == 1 and re.match(r"^[\d.]+$|^Appendix$", words[0])) or (out and out[-1].endswith(":"))
        if not core or not core[0].isalpha() or core[0].isupper() or any(c.isupper() for c in core[1:]) or "_" in core or "`" in w:
            out.append(w)
        elif core.lower() in SMALL and not first and i != len(words) - 1:
            out.append(w)
        else:
            j = w.index(core[0]); out.append(w[:j] + w[j].upper() + w[j + 1:])
    return " ".join(out)


def title_case(s):
    links = []
    def stash(m):
        links.append(m.groups()); return f"\x00{len(links) - 1}\x00"
    s = _tc_plain(re.sub(r"\[([^\]]+)\]\(([^)]+)\)", stash, s))
    return re.sub(r"\x00(\d+)\x00", lambda m: f"[{_tc_plain(links[int(m[1])][0])}]({links[int(m[1])][1]})", s)


def prepare_markdown(md):
    """Title Case for headings and table header rows; the first table becomes a key-value block."""
    lines, in_code = md.split("\n"), False
    for n, l in enumerate(lines):
        if l.startswith("```"): in_code = not in_code
        if in_code: continue
        if l.startswith("#"):
            m = re.match(r"^(#+ )(.*)$", l); lines[n] = m[1] + title_case(m[2])
        elif l.startswith("|") and n + 1 < len(lines) and re.match(r"^\|[-:| ]+\|$", lines[n + 1]):
            lines[n] = "|" + "|".join(" " + title_case(c.strip()) + " " if c.strip() else c for c in l.strip().strip("|").split("|")) + "|"
    return "\n".join(lines)


# ── reference template ────────────────────────────────────────────────────────────────────────
def _rfonts(style, name):
    rpr = style.element.get_or_add_rPr()
    rf = rpr.find(qn("w:rFonts"))
    if rf is None:
        rf = OxmlElement("w:rFonts"); rpr.insert(0, rf)
    for a in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
        rf.set(qn(a), name)
    for a in ("w:asciiTheme", "w:hAnsiTheme", "w:cstheme", "w:eastAsiaTheme"):
        if rf.get(qn(a)) is not None: del rf.attrib[qn(a)]


def _para(style, size, before, after, color=None, bold=None, keep=False, font=None):
    S = STYLE
    _rfonts(style, font or S["font"])
    f = style.font
    f.size, f.bold, f.italic = Pt(size), bold, False
    f.color.rgb = RGBColor.from_string(color or S["text"])
    pf = style.paragraph_format
    pf.space_before, pf.space_after = Pt(before), Pt(after)
    pf.line_spacing = S["line"]
    pf.keep_with_next = keep


def _field(par, instr):
    for kind, text in (("begin", None), (None, instr), ("separate", None), (None, "1"), ("end", None)):
        r = par.add_run()
        if kind:
            fc = OxmlElement("w:fldChar"); fc.set(qn("w:fldCharType"), kind); r._r.append(fc)
        elif text == instr:
            it = OxmlElement("w:instrText"); it.set(qn("xml:space"), "preserve"); it.text = f" {instr} "; r._r.append(it)
        else:
            r.text = text


def make_reference(path):
    S = STYLE
    subprocess.run(["pandoc", "-o", path, "--print-default-data-file", "reference.docx"], check=True)
    d = Document(path)

    class _ByName:                      # python-docx's own lookup misses pandoc's lower-case heading names
        def __getitem__(self, name):
            for x in d.styles:
                if x.name and x.name.lower() == name.lower():
                    return x
            raise KeyError(name)
    st = _ByName()
    _para(st["Normal"], S["body_pt"], 0, S["para_after"])
    for name in ("Body Text", "First Paragraph"):
        _para(st[name], S["body_pt"], 0, S["para_after"])
    _para(st["Compact"], S["body_pt"], 0, S["list_after"])
    for name, key, color, bold in (("Title", "title", S["primary"], False), ("Heading 1", "title", S["primary"], False),
                                   ("Heading 2", "h2", S["primary"], False), ("Heading 3", "h3", S["text"], True),
                                   ("Heading 4", "h4", S["text"], True)):
        size, before, after = S[key]
        _para(st[name], size, before, after, color=color, bold=bold, keep=True)
    _rfonts(st["Verbatim Char"], S["mono"])
    st["Verbatim Char"].font.size = Pt(S["cell_pt"])
    st["Hyperlink"].font.color.rgb = RGBColor.from_string(S["primary"])
    st["Hyperlink"].font.underline = True
    # page: US Letter, 1in margins, footer "page/total" bottom right, not on the first page
    sec = d.sections[0]
    sec.page_width, sec.page_height = Pt(S["page_width_pt"]), Pt(792)
    sec.left_margin = sec.right_margin = sec.top_margin = sec.bottom_margin = Pt(S["margin_pt"])
    sec.different_first_page_header_footer = True
    p = sec.footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    _field(p, "PAGE"); p.add_run("/"); _field(p, "NUMPAGES")
    for r in p.runs:
        r.font.size, r.font.name = Pt(9), S["font"]
    d.save(path)


# ── post-processing ───────────────────────────────────────────────────────────────────────────
def _shade(cell, fill):
    tcpr = cell._tc.get_or_add_tcPr()
    for old in tcpr.findall(qn("w:shd")): tcpr.remove(old)
    shd = OxmlElement("w:shd"); shd.set(qn("w:val"), "clear"); shd.set(qn("w:color"), "auto"); shd.set(qn("w:fill"), fill)
    tcpr.append(shd)


def _borders(table, color):
    tblpr = table._tbl.tblPr
    for old in tblpr.findall(qn("w:tblBorders")): tblpr.remove(old)
    b = OxmlElement("w:tblBorders")
    for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
        e = OxmlElement(f"w:{side}")
        for k, v in (("val", "single"), ("sz", "6"), ("space", "0"), ("color", color)): e.set(qn(f"w:{k}"), v)
        b.append(e)
    tblpr.append(b)
    w = tblpr.find(qn("w:tblW"))
    if w is None:
        w = OxmlElement("w:tblW"); tblpr.append(w)
    w.set(qn("w:type"), "dxa"); w.set(qn("w:w"), str(int((STYLE["page_width_pt"] - 2 * STYLE["margin_pt"]) * 20)))
    look = tblpr.find(qn("w:tblLook"))                              # formatting is direct, never from the table style
    if look is not None:
        for k in ("firstRow", "lastRow", "firstColumn", "lastColumn"): look.set(qn(f"w:{k}"), "0")
        look.set(qn("w:val"), "0000")


def _widths(table, rows):
    """Full text width, split by how much text each column holds (bounded), so label columns stay narrow."""
    total = int((STYLE["page_width_pt"] - 2 * STYLE["margin_pt"]) * 20)     # twips
    ncols = len(rows[0].cells)
    weight = [min(60, max(8, max(max((len(l) for l in r.cells[c].text.split("\n")), default=0) for r in rows))) ** 0.5 for c in range(ncols)]
    widths = [int(total * x / sum(weight)) for x in weight]
    widths[-1] += total - sum(widths)
    grid = table._tbl.tblGrid
    for old in grid.findall(qn("w:gridCol")): grid.remove(old)
    for x in widths:
        gc = OxmlElement("w:gridCol"); gc.set(qn("w:w"), str(x)); grid.append(gc)
    for r in rows:
        for c, cell in enumerate(r.cells):
            tcpr = cell._tc.get_or_add_tcPr()
            tcw = tcpr.find(qn("w:tcW"))
            if tcw is None:
                tcw = OxmlElement("w:tcW"); tcpr.insert(0, tcw)
            tcw.set(qn("w:type"), "dxa"); tcw.set(qn("w:w"), str(widths[c]))
            va = tcpr.find(qn("w:vAlign"))
            if va is None:
                va = OxmlElement("w:vAlign"); tcpr.append(va)
            va.set(qn("w:val"), "top")


def _row_flag(row, tag):
    trpr = row._tr.get_or_add_trPr()
    if trpr.find(qn(f"w:{tag}")) is None: trpr.append(OxmlElement(f"w:{tag}"))


def _blank_after(element, doc):
    """An empty Normal paragraph after a table or diagram: never a heading, never a bullet."""
    nxt = element.getnext()
    if nxt is not None and nxt.tag == qn("w:p") and not "".join(nxt.itertext()).strip() and nxt.find(qn("w:pPr") + "/" + qn("w:numPr")) is None:
        return
    p = OxmlElement("w:p"); ppr = OxmlElement("w:pPr"); sp = OxmlElement("w:spacing")
    sp.set(qn("w:before"), "0"); sp.set(qn("w:after"), "0"); ppr.append(sp); p.append(ppr)
    element.addnext(p)


def post_process(path):
    S = STYLE
    d = Document(path)
    text_width = S["page_width_pt"] - 2 * S["margin_pt"]
    for ti, t in enumerate(d.tables):
        _borders(t, S["border"])
        rows = list(t.rows)
        key_value = ti == 0 and all(not c.text.strip() for c in rows[0].cells)
        if key_value:                                   # document-details block: no header row, title column
            t._tbl.remove(rows[0]._tr); rows = rows[1:]
        _widths(t, rows)
        for ri, row in enumerate(rows):
            _row_flag(row, "cantSplit")                 # a row never splits across pages
            if ri == 0 and not key_value: _row_flag(row, "tblHeader")
            for ci, cell in enumerate(row.cells):
                title = (ci == 0) if key_value else (ri == 0)
                if title: _shade(cell, S["tint"])
                for p in cell.paragraphs:
                    p.paragraph_format.space_before = p.paragraph_format.space_after = Pt(2)
                    p.paragraph_format.keep_with_next = ri < len(rows) - 1 and len(rows) <= 25   # short tables stay whole
                    for r in p.runs:
                        r.font.size = Pt(S["cell_pt"])
                        if title: r.font.bold = True
                    if title and key_value and len(p.runs) == 1:
                        p.runs[0].text = _tc_plain(p.runs[0].text)       # labels are titles too
        _blank_after(t._tbl, d)
    for p in d.paragraphs:
        if p.style.name == "Source Code":
            lines = p.text.split("\n")
            width = max(len(l) for l in lines) * S["mono_pt"] * S["mono_advance"]
            pf = p.paragraph_format
            pf.left_indent = Pt(max(0, (text_width - width) / 2))          # centred as a block, lines stay aligned
            pf.space_before, pf.space_after = Pt(6), Pt(0)
            pf.line_spacing_rule, pf.line_spacing = WD_LINE_SPACING.SINGLE, 1.0
            pf.keep_together = True
            for r in p.runs:
                r.font.name, r.font.size, r.font.bold = S["mono"], Pt(S["mono_pt"]), True
                rf = r._r.get_or_add_rPr().find(qn("w:rFonts"))
                if rf is not None:
                    for a in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"): rf.set(qn(a), S["mono"])
            _blank_after(p._p, d)
    if IDENTITY.get("author"):
        d.core_properties.author = d.core_properties.last_modified_by = IDENTITY["author"]
    d.save(path)


def build(md_path, out_path):
    md = prepare_markdown(open(md_path, encoding="utf-8").read())
    with tempfile.TemporaryDirectory() as tmp:
        ref = str(pathlib.Path(tmp) / "reference.docx")
        make_reference(ref)
        subprocess.run(["pandoc", "-f", "gfm", "-t", "docx", "--reference-doc", ref, "-o", out_path],
                       input=md, text=True, check=True)
    post_process(out_path)


if __name__ == "__main__":
    args = sys.argv[1:]
    config = None
    if args[:1] == ["--config"] and len(args) >= 2:
        config, args = args[1], args[2:]
        if not os.path.isfile(config):
            sys.exit(f"no such config: {config}")
    if len(args) != 2:
        sys.exit(__doc__)
    used = load_config(config)
    build(args[0], args[1])
    print("wrote", args[1], "| config:", used or "none (built-in defaults)",
          "| author:", IDENTITY.get("author", "not set"), "| expected owner:", IDENTITY.get("owner", "not set"))
