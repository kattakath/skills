# ats-safe-pdf

Make a PDF whose **text** reads right, not just its pixels — for applicant tracking systems,
copy-paste and screen readers.

## Why it exists

The usual route — write HTML, print to PDF from a browser — produces files that look fine and
read badly: sidebars and columns come out of order, hyphenated words fuse, letter-spaced
headings vanish from parsers, web fonts embed as Type 3. This plugin carries the measured
alternative:

- **Typst with `--pdf-standard ua-1`**: a tagged, PDF/UA-1 file that veraPDF passes.
- **One column.** Every two-column layout tried scrambled text in a position-based reader in
  at least one configuration; tuning two flowing columns worked 4 times in 30.
- **Design rules for the text layer**: never break inside "event-driven" or "Python/FastAPI",
  leave a gap under headings, no tracking on headings, static fonts only, visible URLs.
- **Verify with several readers**, because they disagree: `pdftotext` (positions, like most
  ATS), `pdftotext -raw` and PDFKit (drawing order), and the tag tree.

On the same résumé content: an HTML theme scored 60 on Reactive Resume's checker, the Typst
single column 99; section detection on Jobalytics went from 70 to 100.

## What it ships

| Path | What |
|---|---|
| `skills/ats-safe-pdf/SKILL.md` | The procedure: engine, layout, text-layer rules, verification, pitfalls |
| `skills/ats-safe-pdf/scripts/pdf-text-check.py` | Order + exactly-once + split-word check over `pdftotext` and `pdftotext -raw`; exit 1 on failure |
| `skills/ats-safe-pdf/scripts/pdfkit-text.swift` | What macOS Preview's copy yields (macOS only) |
| `skills/ats-safe-pdf/references/evidence.md` | Every measurement behind the rules |

## Install

```
/plugin install ats-safe-pdf --marketplace kattakath/skills
```

## Requires

`typst` (≥ 0.14), poppler (`pdftotext`, `pdffonts`), Python 3, and `verapdf` for the PDF/UA
check (Java). All are in nixpkgs.
