"""Write a minimal text-layer PDF from a *.layout.txt fixture, for the poppler smoke test.

No PDF is ever committed: CI generates one in-run, then checks that `pdftotext -layout`
reads it back into the same records as the fixture text. Stdlib only. Courier is one of the
PDF base-14 fonts, so no font is embedded, and its fixed advance (0.6 em) keeps columns.

    python3 make_pdf.py IN.layout.txt OUT.pdf
"""
import sys
from pathlib import Path

SIZE = 7.0           # pt
LEADING = 9.0        # pt between baselines
MARGIN = 18.0
ADVANCE = 0.6 * SIZE  # Courier glyph width


def _escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _encode(s: str) -> bytes:
    # WinAnsiEncoding covers the Latin-1 accents and the em dash the fixtures use.
    return s.encode("cp1252", "replace")


def build(text: str) -> bytes:
    pages = [p.split("\n") for p in text.rstrip("\n").split("\f")]
    width = MARGIN * 2 + ADVANCE * max(len(line) for page in pages for line in page)
    objs: list[bytes] = []
    kids = []
    font_id = 3
    for page in pages:
        height = MARGIN * 2 + LEADING * len(page)
        ops = [b"BT", f"/F1 {SIZE} Tf {LEADING} TL".encode(),
               f"{MARGIN} {height - MARGIN - SIZE} Td".encode()]
        for line in page:
            ops.append(b"(" + _encode(_escape(line)) + b") Tj T*")
        ops.append(b"ET")
        stream = b"\n".join(ops)
        content_id = 4 + len(objs)
        objs.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
        page_id = 4 + len(objs)
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width:.1f} {height:.1f}] "
                    f"/Resources << /Font << /F1 {font_id} 0 R >> >> "
                    f"/Contents {content_id} 0 R >>".encode())
        kids.append(page_id)
    head = [b"<< /Type /Catalog /Pages 2 0 R >>",
            f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] "
            f"/Count {len(kids)} >>".encode(),
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>"]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for n, body in enumerate(head + objs, 1):
        offsets.append(len(out))
        out += f"{n} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(offsets) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(offsets) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


if __name__ == "__main__":
    src, dst = map(Path, sys.argv[1:3])
    dst.write_bytes(build(src.read_text(encoding="utf-8")))
