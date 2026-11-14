---
name: house-style
description: >-
  Create a Google Doc or a PDF in the operator's fixed house style by RUNNING A SCRIPT, never by
  applying style rules by hand, through Docs API edits, or by printing HTML from a browser. One
  style file feeds both outputs: Google Sans, JetBrains Mono for diagrams, Material blue titles,
  tinted table title rows, Title Case titles, page numbers. Markdown in; out comes a .docx that
  Google Drive converts into a Google Doc, or a tagged PDF/UA-1 file. Use when the user says
  "create a Google Doc", "put this in Google Docs", "make a PDF of this", "export this as a PDF",
  "write this up as a Doc / PDF", "generate a report / plan / architecture / memo / proposal",
  or asks for a document "in my style" or "the house style". Also use before any attempt to
  style a Google Doc with updateTextStyle / updateParagraphStyle batches. Not for résumés.
---

# House style: Google Docs and PDF from one definition

The style is data. `style.json` holds the two fonts and five colours; `scripts/gdoc.py` and
`scripts/pdf.py` apply them. Do not restate the style in a prompt, do not restyle a Doc through
the Docs API, and do not build a PDF another way. Styling by hand took a full session of
corrections and still could not add page numbers or keep tables on one page.

## 1. Write the content as Markdown

GitHub flavour, starting with one `# Title` line. Diagrams go in fenced code blocks, drawn with
box-drawing characters. A details block (prepared for, date, status) is a two-column table with
an empty header row, directly under the title:

```markdown
# Title of the Document

| | |
|---|---|
| **Prepared for** | … |
| **Date** | … |
```

## 2a. Google Doc

Needs `pandoc` and `python-docx`. Where `$HOUSE_STYLE_PYTHON` is set, it names an interpreter
that has them; use it for every script here.

```bash
${HOUSE_STYLE_PYTHON:-python3} scripts/gdoc.py report.md report.docx
```

- **Import it.** Upload the `.docx` to Drive with conversion on. With the Google Drive
  connector: `create_file`, `contentMimeType`
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document`. Drive returns a
  native Google Doc.
- **Check the owner.** The script prints the account it expects to own the Doc. A different
  `owner` in Drive's reply means the upload went to the wrong account.
- **Check the rendered result, not the API reply.** Export the Doc to PDF and run
  `python3 scripts/font_probe.py exported.pdf`. Every diagram page must list **one** monospace
  font with **one** width for letters and for each of `─ │ ┌ ┐ └ ┘ ┬ ┴ ▼ ▲ →`. Then look at the
  first pages.

## 2b. PDF

Needs `pandoc`, and `typst` (the command, or the Python package).

```bash
${HOUSE_STYLE_PYTHON:-python3} scripts/pdf.py report.md report.pdf
```

- `--footer "Text"` sets the left side of the page footer; it defaults to the title. Use it for
  a confidentiality line.
- **Check:** `pdffonts report.pdf` lists only `GoogleSans…` and `JetBrainsMono…`, all
  `CID TrueType`. Then look at the first pages and every diagram page. For a PDF that software
  will parse, also run the `ats-safe-pdf` plugin's `/pdf-check`.

## Identity and overrides come from a config file

**No name, account or personal colour belongs in a script or a prompt.** Both scripts read a
JSON config from `--config`, `$HOUSE_STYLE_CONFIG`, or `$XDG_CONFIG_HOME/house-style/config.json`,
which the operator's system configuration generates. Each script prints the config it used and
the author it set. Without a config the built-in style applies and no author is set.

```json
{"identity": {"author": "Full Name", "owner": "account@example.com"},
 "style": {"primary": "0B57D0"}}
```

## What is fixed, and where

| Decision | Value | Lives in |
|---|---|---|
| Fonts | Google Sans; JetBrains Mono for diagrams and code | `style.json` |
| Colours | primary `#0B57D0`, tint `#E8F0FE`, border `#C4C7C5`, text `#1F1F1F`, meta `#444746` | `style.json` |
| Title and section headings | Primary colour, regular weight | both |
| Titles | Title Case for headings, table headers and detail labels; names with their own casing are left alone | `scripts/common.py` |
| Tables | Full grid in the border colour, tinted bold title row, full width, rows never split | both |
| Details block | Label **column** tinted and bold, no header row | both |
| Diagrams | Monospace bold, no background, centred as a block, kept on one page | both |
| Page numbers | Doc: `page/total` bottom right, not on page 1. PDF: "Page N of M" beside the footer text | each script |
| PDF type and spacing | Material 3 scale at 0.75pt per px, 1in side margins, a primary strip on the top edge | `theme/theme.typ` |
| Doc sizes and spacing | Docs' default heading rhythm | `scripts/gdoc.py` |

Why these cannot be left to a prompt, all measured:

- **Docs' Consolas has no box-drawing or arrow glyphs.** They fall back to Arial at other
  widths and every border drifts. JetBrains Mono has them all.
- **The Docs API has no request that inserts a page-number field.** A Word field converts into
  a real one on import.
- **A blank line inserted through the Docs API inherits a heading style or a bullet.**
- **HTML printed from a browser splits tables and leaves titles alone at the foot of a page.**

## Limits

- **A Google Doc build is a new document.** Drive cannot replace the content of an existing
  Doc, so the link changes. Say so.
- **Google Docs can still continue a table onto the next page.** It has no setting that keeps
  a whole table together. The PDF keeps any table that fits on one page whole.
- **PDF/UA-1 is strict.** Typst refuses a document that skips a heading level (`##` straight to
  `####`). Fix the Markdown. `--no-ua` writes a tagged PDF without the claim, as a last resort.
- **Word styles carry regular or bold only**, so Doc section headings are regular weight.
- **Changing the style means changing `style.json`** (or `theme/theme.typ` for PDF layout) and
  bumping this plugin's version, never adding a rule to a prompt.
