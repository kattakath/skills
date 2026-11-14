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

| Path | Purpose |
|---|---|
| `skills/house-style/SKILL.md` | When to use it, the steps for each output, the limits |
| `skills/house-style/style.json` | **The style**: two fonts and five colours |
| `skills/house-style/scripts/common.py` | Loads the style and the config; Title Case |
| `skills/house-style/scripts/gdoc.py` | `Markdown -> .docx` for Drive to convert |
| `skills/house-style/scripts/pdf.py` | `Markdown -> PDF/UA-1` through pandoc and Typst |
| `skills/house-style/theme/theme.typ` | PDF layout: type scale, spacing, tables, diagrams, footer |
| `skills/house-style/theme/fonts/` | Google Sans and JetBrains Mono static files, each with its `OFL.txt` |
| `skills/house-style/scripts/font_probe.py` | Reads a PDF and reports which font drew each diagram character, and at what width |

## Identity and overrides come from a config file

The scripts carry **no identity**. A JSON config supplies the author, the account expected to
own a Google Doc, and any style override. It is read from `--config`, `$HOUSE_STYLE_CONFIG`, or
`$XDG_CONFIG_HOME/house-style/config.json`. Generate that file from wherever identity is
already declared (on the author's fleet, a Nix home module writes it). An unknown key is an
error, not a silent no-op.

## Why not an existing tool

- **typix** (a Nix flake for Typst) builds one fixed project inside a flake. This needs a
  command that turns any Markdown file into a PDF at run time, also where Nix is absent.
- **The Google Sans in nixpkgs' `google-fonts`** is the variable font. The PDF theme uses
  static cuts, including the 17pt optical size, so the fonts are vendored with their licences.
- **A pandoc reference document or template alone** cannot express the table formatting, the
  diagram centring, the details block or Title Case. pandoc still does both conversions.

## Measured, not assumed

- **Consolas does not work for box-drawing diagrams in Google Docs.** Its Docs version lacks
  `─ │ ┌ ┐ └ ┘ ┬ ┴ ▼ ▲ →`; they render in Arial at three different widths. JetBrains Mono,
  Source Code Pro and Courier New draw all of them at the letter width.
- **A converted `.docx` keeps:** both fonts by name, heading spacing, keep-with-next, table
  shading and borders, column widths, "row cannot split", repeated header rows and the footer
  fields. Checked by exporting the converted Doc to PDF.
- **The PDF** embeds three Google Sans cuts and two JetBrains Mono cuts as CID TrueType and
  nothing else; every diagram character comes from one font at one width; no table that fits
  on a page is split and no title sits alone at a page end (34-page document, Typst 0.15.2).
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
