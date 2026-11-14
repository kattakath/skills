---
name: gdoc-house-style
description: >-
  Create a Google Doc in the operator's fixed house style by RUNNING A SCRIPT, never by applying
  style rules by hand or through Docs API edits. Markdown in, a styled .docx out, which Google
  Drive converts into a Google Doc: Google Sans, Material blue headings, full-width tables with
  a tinted bold title row, box-drawing diagrams that line up, Title Case titles, a blank line
  after every table and diagram, and a bottom-right "page/total" footer that skips page 1. Use
  when the user says "create a Google Doc", "put this in Google Docs", "make a Doc of this
  report / plan / architecture / memo", "write this up as a Google Doc", or asks to restyle a
  document "in my Docs style" or "the house style". Also use before any attempt to style a
  Google Doc with updateTextStyle / updateParagraphStyle batches: build it with this instead.
---

# Google Docs house style

The style is code. `scripts/house_style.py` holds every decision in one `STYLE` table and
applies it the same way every time. Do not restate the style in a prompt, and do not restyle a
Doc request by request through the Docs API: that route took a full session of corrections
and still could not add page numbers.

## Steps

1. **Write the content as Markdown** (GitHub flavour). Headings, lists, tables, links, fenced
   code blocks for diagrams. If the document opens with a details block (prepared for, date,
   status), write it as the first table with an empty header row:

   ```markdown
   | | |
   |---|---|
   | **Prepared for** | … |
   | **Date** | … |
   ```

2. **Build the Word file.** Needs `pandoc` and `python-docx`.

   ```bash
   python3 scripts/house_style.py report.md report.docx
   ```

3. **Import it as a Google Doc.** Upload the `.docx` to Drive with conversion on. With the
   Google Drive connector: `create_file`, `contentMimeType`
   `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, conversion left
   at its default. Drive returns a native Google Doc.

4. **Check the rendered result, not the API reply.** Export the Doc to PDF and run:

   ```bash
   python3 scripts/font_probe.py exported.pdf
   ```

   Every diagram page must list **one** monospace font with **one** advance width for letters
   and for each of `─ │ ┌ ┐ └ ┘ ┬ ┴ ▼ ▲ →`. Two fonts, or two widths, means the borders drift.
   Then look at the first pages.

## What the script fixes, and why it is a script

| Decision | Value | Why it cannot be left to a prompt |
|---|---|---|
| Body and headings | Google Sans; title and sections Material blue `#0B57D0` | An HTML import picks its own colours and web margins |
| Heading rhythm | Docs' default spacing (section 18 pt above / 6 below), keep-with-next | The import overwrites margins unevenly; 26 of 60 headings lost their space above |
| Diagrams | JetBrains Mono, bold, no background, centred as a block, kept on one page | **Docs' Consolas has no box-drawing or arrow glyphs**: they fall back to Arial at other widths and every border drifts (measured 2026-11-14). JetBrains Mono, Source Code Pro and Courier New have them all |
| Diagram centring | Left indent computed from the longest line | Centre alignment would centre each line separately and break the boxes |
| Tables | Full grid, border `#C4C7C5`, tinted bold title row, full text width, columns sized by content, rows never split, header row repeats | Imported tables come half-width with equal columns |
| Details block | Title **column** tinted and bold, no header row | Same |
| Titles | Title Case for headings, table headers and detail labels | Names with their own casing are left alone |
| After tables and diagrams | One empty Normal paragraph | Inserted through the API it inherits a heading style or a **bullet** |
| Footer | Right-aligned `page/total`, not on page 1 | **The Docs API has no request that inserts a page-number or page-count field.** A Word field converts into a real one |

## Limits

- **A new document, not an edit.** Drive cannot replace the content of an existing Google Doc,
  so this produces a new Doc with a new link. To restyle an existing Doc, export or rewrite
  its content as Markdown and build again; tell the user the link changes.
- **Tables can still continue onto the next page.** Docs keeps a row whole and repeats the
  header row, but has no setting that keeps a whole table on one page.
- **No medium weight.** Word styles carry regular or bold only, so section headings are
  regular weight.
- **Changing the style means changing `STYLE`** in the script and bumping this plugin's
  version, never adding a rule to a prompt.
