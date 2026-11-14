# gdoc-house-style

Builds a Google Doc in one fixed house style from a script. Markdown goes in; a styled Word
file comes out; Google Drive converts that into a native Google Doc.

## Why this exists

Styling a Google Doc through the Docs API, one batch of edits at a time, is slow and not
repeatable, and it cannot do everything. Two findings from the session that produced this
plugin (2026-11-14) decided the design:

- **The Docs API cannot insert a page-number or page-count field.** A Word `PAGE` /
  `NUMPAGES` field does convert into a real one on import, including "different first page".
- **A font change through the API silently erases bold**, because bold is a weight and a font
  family set without one resets every run to 400. A generated file has no such ordering trap.

So the style lives in `scripts/house_style.py` as data, and the document is generated whole.

## What it ships

| Path | Purpose |
|---|---|
| `skills/gdoc-house-style/SKILL.md` | When to use it, the four steps, the limits |
| `skills/gdoc-house-style/scripts/house_style.py` | `Markdown -> .docx` in the house style; all decisions in its `STYLE` table |
| `skills/gdoc-house-style/scripts/font_probe.py` | Reads an exported PDF and reports which font drew each diagram character, and at what width |

## Measured, not assumed

- **Consolas does not work for box-drawing diagrams in Google Docs.** Its Docs version lacks
  `─ │ ┌ ┐ └ ┘ ┬ ┴ ▼ ▲ →`; they render in Arial at three different widths. JetBrains Mono,
  Source Code Pro and Courier New draw all of them at the letter width. Roboto Mono borrows
  Courier New's.
- **A converted `.docx` keeps:** Google Sans and JetBrains Mono by name, heading spacing,
  keep-with-next, direct table shading and borders, explicit column widths, "row cannot
  split", repeated header rows, and the footer fields. Checked by exporting the converted Doc
  to PDF.
- **It does not keep a whole table on one page**; Docs has no such setting.

## Requirements

`pandoc`, Python 3 with `python-docx`, and for the probe `pdfminer.six`. Uploading needs any
route into Google Drive that converts on upload, such as the Google Drive connector.
