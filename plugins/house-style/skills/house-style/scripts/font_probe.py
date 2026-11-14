"""font_probe.py <exported.pdf>

For each page of an exported Google Doc that holds a box-drawing diagram: which font drew each
kind of character, and at what advance. One monospace font at one width means the borders line
up; a second font or width means they drift. Requires pdfminer.six.
"""
import sys, collections
from pdfminer.high_level import extract_pages
from pdfminer.layout import LTChar

BOX = set("─│┌┐└┘┬┴▼▲→")
for n, page in enumerate(extract_pages(sys.argv[1]), 1):
    fonts = collections.defaultdict(lambda: collections.defaultdict(set))
    stack = [page]
    while stack:
        o = stack.pop()
        if isinstance(o, LTChar):
            ch = o.get_text()
            if len(ch) == 1:
                f = o.fontname.split("+")[-1]
                if ch in BOX:
                    fonts[f][ch].add(round(o.adv, 2))
                elif "Mono" in f or "Courier" in f or "Code" in f or "Consolas" in f:
                    fonts[f]["ascii"].add(round(o.adv, 2))
        elif hasattr(o, "__iter__"):
            stack.extend(o)
    if any(set(v) & BOX for v in fonts.values()):
        print("page", n)
        for f, d in fonts.items():
            print("   ", f, {k: sorted(v) for k, v in d.items()})
