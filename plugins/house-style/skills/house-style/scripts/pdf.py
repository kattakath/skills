#!/usr/bin/env python3
"""Markdown -> a tagged PDF (PDF/UA-1) in the house style.

    pdf.py [--config FILE] [--footer TEXT] [--no-ua] <in.md> <out.pdf>

Fonts and colours come from ../style.json, the identity from the config (see common.py); the
layout is ../theme/theme.typ. Only the fonts in ../theme/fonts are used, so the result is the
same on every machine. Pipeline: this script applies Title Case and lifts the title and the
details block out of the Markdown, pandoc turns the rest into Typst, and Typst compiles it.
Requires: pandoc, and either the `typst` command or the `typst` Python package.
"""
import argparse, json, os, pathlib, re, shutil, subprocess, sys, tempfile

from common import IDENTITY, SHARED, SKILL, STYLE, load_config, title_case

THEME = SKILL / "theme"


# ── Markdown -> Typst ─────────────────────────────────────────────────────────────────────────
def pandoc(md):
    return subprocess.run(["pandoc", "-f", "gfm", "-t", "typst", "--wrap=none"], input=md,
                          capture_output=True, text=True, check=True).stdout


def split_front(md):
    """Return (title, detail rows, body lines). The title is the first `# ` line. The details
    block is a table that follows it before any other content, as in the Docs house style."""
    lines = md.split("\n")
    i = 0
    while i < len(lines) and not lines[i].strip(): i += 1
    if i == len(lines) or not lines[i].startswith("# "):
        sys.exit("the document must start with a '# Title' line")
    title = lines[i][2:].strip()
    i += 1
    j = i
    while j < len(lines) and not lines[j].strip(): j += 1
    rows = []
    if j < len(lines) and lines[j].startswith("|"):
        while j < len(lines) and lines[j].startswith("|"):
            cells = [c.strip() for c in lines[j].strip().strip("|").split("|")]
            if any(cells) and not set("".join(cells)) <= set("-: "):
                rows.append(cells)
            j += 1
        if all(len(r) == 2 for r in rows):
            i = j
        else:
            rows = []  # an ordinary table, not a details block: leave it in the body
    return title, rows, lines[i:]


def prepare_body(body):
    """Title Case for headings and table header rows. A short bold line standing alone becomes a
    heading one level below the current one, so it stays with the table or list it introduces."""
    in_code, level = False, 1
    for n, l in enumerate(body):
        if l.startswith("```"): in_code = not in_code
        if in_code: continue
        if l.startswith("#"):
            m = re.match(r"^(#+ )(.*)$", l); body[n] = m[1] + title_case(m[2]); level = len(m[1]) - 1
        elif l.startswith("|") and n + 1 < len(body) and re.match(r"^\|[-:| ]+\|$", body[n + 1]):
            body[n] = "|" + "|".join(" " + title_case(c.strip()) + " " if c.strip() else c for c in l.strip().strip("|").split("|")) + "|"
        elif re.match(r"^\*\*[^*]+\*\*$", l.strip()) and len(l) < 70:
            body[n] = "#" * (level + 1) + " " + title_case(l.strip().strip("*"))
    return body


def typ_string(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def to_typst(md, footer=None):
    title, rows, body = split_front(md)
    typ_body = pandoc("\n".join(prepare_body(body)))
    typ_body = typ_body.replace("#align(center)[#table(", "#[#table(")  # pandoc centres tables; the theme wants full width
    # each appendix starts on a new page, so its title never sits alone at a page end
    typ_body = re.sub(r"(?m)^(== Appendix )", r"#pagebreak(weak: true)\n\1", typ_body)
    setup = [f"title: {typ_string(title)}"]
    if IDENTITY.get("author"):
        setup.append(f"author: {typ_string(IDENTITY['author'])}")
    setup.append(f"footer: [{pandoc(footer if footer is not None else title).strip()}]")
    details = ""
    if rows:
        cells = ",\n  ".join(f"([{pandoc(title_case(a.strip('*'))).strip()}], [{pandoc(b).strip()}])" for a, b in rows)
        details = f"#details(\n  {cells},\n)\n\n"
    return f'#import "theme.typ": *\n#show: setup.with({", ".join(setup)})\n\n= {pandoc(title).strip()}\n\n{details}{typ_body}'


# ── Compile ───────────────────────────────────────────────────────────────────────────────────
def compile_pdf(typ, out, ua=True):
    """Compile in a scratch folder holding a copy of the theme. Fonts come from theme/fonts only;
    system fonts are ignored. The style reaches the theme as one JSON input."""
    fonts = str(THEME / "fonts")
    style = json.dumps({k: STYLE[k] for k in sorted(SHARED)})
    with tempfile.TemporaryDirectory() as tmp:
        shutil.copy(THEME / "theme.typ", tmp)
        src = pathlib.Path(tmp) / "doc.typ"
        src.write_text(typ, encoding="utf-8")
        if shutil.which("typst"):
            cmd = ["typst", "compile", "--font-path", fonts, "--ignore-system-fonts", "--input", "style=" + style]
            cmd += ["--pdf-standard", "ua-1"] if ua else []
            r = subprocess.run(cmd + [str(src), out], capture_output=True, text=True)
            if r.returncode:
                sys.exit(r.stderr.strip())
            return "typst " + subprocess.run(["typst", "--version"], capture_output=True, text=True).stdout.split()[1]
        try:
            import typst
        except ImportError:
            sys.exit("neither the `typst` command nor the `typst` Python package is available")
        try:
            typst.compile(str(src), output=out, font_paths=[fonts], ignore_system_fonts=True, sys_inputs={"style": style},
                          **({"pdf_standards": ["ua-1"]} if ua else {}))
        except Exception as e:  # the binding raises its own error types; report and stop
            sys.exit(str(e).strip())
        return "typst (Python package)"


def main():
    ap = argparse.ArgumentParser(description="Markdown -> PDF/UA-1 in the house style")
    ap.add_argument("--config")
    ap.add_argument("--footer", help="left side of the page footer (Markdown); defaults to the title")
    ap.add_argument("--no-ua", action="store_true", help="tagged PDF without the PDF/UA-1 claim, for a document Typst refuses")
    ap.add_argument("markdown")
    ap.add_argument("pdf")
    a = ap.parse_args()
    cfg = load_config(a.config)
    typ = to_typst(open(a.markdown, encoding="utf-8").read(), a.footer)
    engine = compile_pdf(typ, a.pdf, ua=not a.no_ua)
    print(f"{a.pdf}: {'tagged, no PDF/UA-1 claim' if a.no_ua else 'PDF/UA-1'} | {engine} | "
          f"config: {cfg or 'none'} | author: {IDENTITY.get('author', 'not set')}")


if __name__ == "__main__":
    main()
