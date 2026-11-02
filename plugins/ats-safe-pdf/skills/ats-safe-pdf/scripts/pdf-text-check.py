#!/usr/bin/env python3
"""pdf-text-check.py <pdf> [--markers FILE] [--once FILE]

Does an ATS-style text extraction of <pdf> read IN ORDER and COMPLETE? Three readers, because
they disagree in practice:
  geo  `pdftotext`             — rebuilds lines from positions on the page (most ATS parsers)
  raw  `pdftotext -raw`        — the PDF's stored drawing order
  tags `pdfinfo -struct-text`  — text in TAG-TREE order (screen readers); markers only, since a
       tag dump repeats heading text. veraPDF validates tag structure but checks no order, and
       Typst once emitted valid tags in the wrong order (typst#7763, fixed in 0.15).
       Skipped with a note when the PDF is untagged or poppler is older than ~22.
Checks per reader:
  order     every line of --markers (in file order) appears at the START of an extracted line,
            in that order. Anchoring matters: "AWS:" must not match "…SaaS on AWS:" mid-text.
  complete  every line of --once appears exactly once (whitespace-normalised)
  splits    no word broken at a line end ("event-" / "driven") and no "Python/ FastAPI" split
Blank lines and lines starting with '#' in either file are ignored.
Exit 1 on any failure. Needs poppler (pdftotext). Standard library only.
"""

import argparse
import re
import subprocess
import sys


def norm(s):
    return re.sub(r"\s+", " ", s)


def lines(path):
    if not path:
        return []
    with open(path, encoding="utf-8") as f:
        return [ln.rstrip("\n") for ln in f if ln.strip() and not ln.lstrip().startswith("#")]


def extract(pdf, raw):
    args = ["pdftotext"] + (["-raw"] if raw else []) + [pdf, "-"]
    text = subprocess.run(args, check=True, capture_output=True, text=True).stdout
    return text.replace("\f", "\n")  # a page break is a line break


def tag_text(pdf):
    """Text content in structure-tree order, one fragment per line; None if unavailable."""
    # The dump carries some attribute values as raw UTF-16 (a 0xFE byte-order mark was seen),
    # so decode leniently; only the quoted text fragments below are used.
    p = subprocess.run(["pdfinfo", "-struct-text", pdf], capture_output=True, text=True, errors="replace")
    if p.returncode != 0:
        return None
    frags = [m.group(1) for m in re.finditer(r'(?m)^\s*"(.*)"\s*$', p.stdout)]
    return " ".join(frags) if frags else None


def tag_order(pdf, markers):
    """Markers must appear in tag order: each searched for after the previous one's match."""
    text = tag_text(pdf)
    if text is None:
        print("tags SKIP: no structure tree (untagged PDF, or poppler without -struct-text)")
        return True
    flat, at, out_of_order, missing = norm(text), 0, [], []
    for m in markers:
        i = flat.find(norm(m), at)
        if i >= 0:
            at = i + len(norm(m))
        elif norm(m) in flat:
            out_of_order.append(m)
        else:
            missing.append(m)
    ok = not (out_of_order or missing)
    print(f"tags {'PASS' if ok else 'FAIL'}: markers in tag order {len(markers) - len(out_of_order) - len(missing)}/{len(markers)}")
    if out_of_order:
        print("     out of tag order: " + " | ".join(out_of_order))
    if missing:
        print("     missing from tags: " + " | ".join(missing))
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf")
    ap.add_argument("--markers", help="ordered headings / entry titles, one per line")
    ap.add_argument("--once", help="strings that must appear exactly once, one per line")
    a = ap.parse_args()
    markers, once = lines(a.markers), lines(a.once)

    failed = False
    for reader, raw in (("geo", False), ("raw", True)):
        text = extract(a.pdf, raw)
        flat = norm(text)
        pos = []
        for m in markers:
            words = r"\s+".join(re.escape(w) for w in m.split())
            hit = re.search(r"(?m)^[ \t]*" + words, text)
            pos.append((len(norm(text[: hit.start()])) if hit else -1, m))
        missing = [m for i, m in pos if i < 0]
        got = [m for _, m in sorted(p for p in pos if p[0] >= 0)]
        want = [m for i, m in pos if i >= 0]
        inversions = sum(1 for x in range(len(got)) for y in range(x + 1, len(got)) if want.index(got[x]) > want.index(got[y]))
        bad = [s for s in once if flat.count(norm(s)) != 1]
        splits = len(re.findall(r"[A-Za-z]-\n", text)) + len(re.findall(r"[A-Za-z]/ [A-Za-z]", flat))
        ok = not (missing or inversions or bad or splits)
        failed |= not ok
        print(f"{reader:4} {'PASS' if ok else 'FAIL'}: order {'ok' if not inversions else f'{inversions} inversions'};"
              f" markers {len(markers) - len(missing)}/{len(markers)}; once {len(once) - len(bad)}/{len(once)}; splits {splits}")
        if missing:
            print("     missing: " + " | ".join(missing))
        if inversions:
            print("     read as: " + " > ".join(got))
        for s in bad:
            print(f"     not exactly once ({flat.count(norm(s))}x): {s[:80]}")
    if markers:
        failed |= not tag_order(a.pdf, markers)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
