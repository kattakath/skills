# house-style

Builds a Google Doc or a PDF in one fixed house style from a script. Markdown goes in. Out
comes a styled Word file that Google Drive converts into a native Google Doc, or a tagged
PDF/UA-1 file. Both read the same style file, so they cannot drift apart.

## Why this exists

The style was first applied by hand, request by request, and the same faults kept coming back.
Three findings (2026-11-14) decided the design:

- **The Docs API cannot insert a page-number or page-count field.** A Word `PAGE` /
  `NUMPAGES` field does convert into a real one on import, including "different first page".
- **A font change through the Docs API silently erases bold**, because bold is a weight and a
  font family set without one resets every run to 400. A generated file has no such trap.
- **The Doc and the PDF had two themes** (blue and purple, two diagram fonts) because each was
  styled separately. One `style.json` now feeds both.

## What it ships

All under `skills/house-style/`:

| Path | Purpose |
|---|---|
| `SKILL.md` | When to use it, the steps for each output, what is fixed, the limits |
| `typst/local/house-style/1.0.0/` | A Typst package. `style.json` is **the style**; `base.typ` turns it into tokens (colours, fonts, the Material 3 print scale, spacing); `document.typ` is the long-form layout |
| `fonts/` | Google Sans and JetBrains Mono static files, each with its `OFL.txt` |
| `scripts/common.py` | Loads the style and the identity config; Title Case |
| `scripts/gdoc.py` | `Markdown -> .docx` for Drive to convert |
| `scripts/pdf.py` | `Markdown -> PDF/UA-1` through pandoc and Typst |
| `scripts/font_probe.py` | Reads a PDF and reports which font drew each diagram character, and at what width |

The package is importable by any Typst document (`--package-path` at the `typst` folder), so a
layout kept elsewhere, such as a résumé theme, takes its fonts and tokens from here instead of
keeping a copy.

## Why not an existing tool

- **typix** (a Nix flake for Typst) builds one fixed project inside a flake. This needs a
  command that turns any Markdown file into a PDF at run time, also where Nix is absent.
- **The Google Sans in nixpkgs' `google-fonts`** is the variable font. The PDF theme uses
  static cuts, including the 17pt optical size, so the fonts are vendored with their licences.
- **A pandoc reference document or template alone** cannot express the table formatting, the
  diagram centring, the details block or Title Case. pandoc still does both conversions.

## Measured, not assumed

- **A converted `.docx` keeps:** both fonts by name, heading spacing, keep-with-next, table
  shading and borders, column widths, "row cannot split", repeated header rows and the footer
  fields. Checked by exporting the converted Doc to PDF.
- **The PDF** embeds three Google Sans cuts and two JetBrains Mono cuts as CID TrueType and
  nothing else; every diagram character comes from one font at one width; no table that fits
  on a page is split and no title sits alone at a page end (34-page document, Typst 0.15.2).
- **The résumé that imports the package** renders the same 5 pages with identical text as it
  did from its own copy of the tokens.
- **Moving the style into one file changed nothing in the Doc**: the Word file's document,
  styles and footer parts are byte-identical before and after.

## Install

```
/plugin install house-style --marketplace kattakath/skills
```

## Requirements

`pandoc`; Python 3 with `python-docx` for Docs; `typst` (command or Python package) for PDF;
`pdfminer.six` for the probe. Uploading needs a route into Google Drive that converts on
upload, such as the Google Drive connector.
