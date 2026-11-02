---
name: ats-safe-pdf
description: >-
  Produce PDFs whose TEXT LAYER reads correctly — for applicant tracking systems (ATS),
  copy-paste and screen readers — instead of HTML → browser "print to PDF". Covers the engine
  (Typst with PDF/UA-1 tagging), layout rules (why sidebars and multi-column flows scramble
  extracted text), the text-layer defects to design out (hyphen/slash splits, glued headings,
  Type 3 fonts, letter-spaced headings) and how to VERIFY with several readers. Use when the
  user says "make my résumé/CV/cover letter PDF ATS friendly", "the PDF text order is wrong
  when I copy it", "two-column PDF reads out of order", "render this as a proper/tagged/
  accessible PDF", "PDF/UA", "print to PDF breaks the ATS", or is about to generate any
  document PDF that a machine will parse.
version: 1.1.0
---

# ATS-safe PDF — render the text layer, not just the look

**What and when.** A PDF has three separate orders: the order text is **drawn**, its
**position** on the page, and the **tag tree**. Most ATS parsers and `pdftotext` rebuild text
from positions; macOS Preview's copy uses drawing order; screen readers use tags. A document is
only safe when all three agree — and an HTML page printed from a browser routinely breaks one.
Use this whenever a PDF will be parsed by software, above all résumés and cover letters.

Evidence for every rule below (measurements, readers, scores): [`references/evidence.md`](references/evidence.md).

## Steps

1. **Pick the engine: Typst, with PDF/UA-1.**
   `typst compile --pdf-standard ua-1 --font-path fonts --ignore-system-fonts doc.typ out.pdf`
   - Typst (≥ 0.14; measured on 0.15.1) writes a **tagged** PDF and PDF/UA-1 on request; it
     reads JSON/YAML/CSV natively, so data stays separate from layout.
   - Pass data that lives outside the project as an input, not a file — Typst can only read
     files under its root: `--input data="$(cat data.json)"` and `json(bytes(sys.inputs.data))`.
   - **Check:** veraPDF passes — `verapdf --flavour ua1 --format text out.pdf` prints `PASS`.
     (`nixpkgs#verapdf`; Java.)
   - Why not HTML → Chrome: see Pitfalls. WeasyPrint has an experimental `pdf/ua-1` variant and
     Prince is commercial; neither was measured here.

2. **Lay it out in ONE column.** Section order on the page = order in the source.
   - Sidebars and newspaper columns reorder text in position-based readers (step 5). If a
     design truly needs a sidebar: it must **end on page 1**, and nothing in it may share a
     baseline with a heading in the main column. Guard that with an `assert` in the template;
     still verify every build, because the outcome depends on where content lands.
   - A two-cell row (label | text, e.g. a skills table) is safe only while the label cell is
     ONE line and top-aligned, and the label ends with a separator (`:`), or readers fuse the
     label into the first word. A hanging indent gives the same scannable left edge with none
     of that risk.
   - **Line length:** aim for 45–75 characters per line (Bringhurst; WCAG 1.4.8 AAA ≤ 80). At
     10–10.5pt on US Letter that is about 1in side margins; full width at small type runs past
     100 — beyond what any readability study tested.

3. **Design the text-layer defects out** (each one measured):
   | Defect | Design rule |
   |---|---|
   | "event-" ⏎ "driven" extracts as "eventdriven" | never break inside a hyphen/slash compound: `show regex("~?[A-Za-z0-9.]+([-/][A-Za-z0-9.]+)+"): it => box(it)` and `set text(hyphenate: false)` |
   | "Python/" ⏎ "FastAPI" extracts as "Python/ FastAPI" | the same box covers `/` |
   | A heading and the line under it copy as one ("Acme CorpMar 2026") | ≥ ~6pt (8dp) between a heading and the next line |
   | "S U M M A R Y" — letter-spaced headings hide sections from ATS | no tracking on headings |
   | Type 3 fonts (some checkers cap the score) | **static** font files only; check `pdffonts` shows `CID TrueType` |
   | A glyph missing from the font falls back to a serif | check `pdffonts` for unexpected families |
   | Link text that is a word ("LinkedIn") | show the visible URL text |
   - Decoration (page backgrounds, rules, colour strips) becomes a tagged **artifact** — fine.
     **Headers and footers are still copied** by every text extractor despite artifact tagging;
     keep them out unless they earn their place.

4. **Fonts: vendor the static files with their licence.** For an OFL font (Google Fonts),
   commit the exact static cuts used plus `OFL.txt` **with its copyright line** (the
   google/fonts repo's copy has it; some download bundles omit it) and any `TRADEMARKS.md`. A
   variable font file is a Type 3 risk in browsers; in Typst use the static cuts. Match optical
   size to type size when the family ships several cuts.

5. **Verify with more than one reader** — they disagree in practice.
   ```bash
   pdffonts out.pdf                       # CID TrueType, no Type 3, expected families only
   verapdf --flavour ua1 --format text out.pdf | grep -q '^PASS'
   python3 scripts/pdf-text-check.py out.pdf --markers markers.txt --once items.txt
   swift scripts/pdfkit-text.swift out.pdf   # macOS: what Preview's select-all copy yields
   ```
   - `markers.txt`: one line per heading/entry title **in the order they must read**; each must
     START a line of extracted text (anchoring stops "…on AWS:" in a summary matching an
     "AWS:" group). `items.txt`: strings that must appear exactly once (each bullet).
   - The script checks three orders: `pdftotext` (position), `pdftotext -raw` (drawing) and
     `pdfinfo -struct-text` (the **tag tree** — what screen readers follow), and counts split
     compounds. **Check:** exit 0. Prove it can fail once: run it against the wrong document
     (or swap two markers) and expect exit 1.
   - The tag leg exists because veraPDF validates tag *structure* but has **no rule about
     order**, and Typst once shipped valid tags in the wrong order (typst#7763, fixed in 0.15).
   - **Never derive the expected order from the PDF under test** — take it from the source.
   - For a PDF from any generator, `/pdf-check <file>` runs this whole step.

6. **Optional — score on real ATS checkers.** Reactive Resume's free checker (parse quality)
   and Jobalytics (keyword match + sections). **Human gate:** uploading a résumé to a third
   party shares personal data — ask first. Upload under a real name like
   `<Name>-<Role>.pdf`: Jobalytics scores the **filename** ("…Final.pdf" cost 8 points).

## What no tool settles (scope)

- PDF/UA's test catalogue (Matterhorn 1.1) has 136 failure conditions; **47 need a human** —
  among them "tags in logical reading order" (09-001), whether a tag is the right kind, and
  whether alt text and language are appropriate. This skill checks the machine half plus text
  and tag ORDER against an expected order you supply; it does not certify accessibility.
- Content beyond text, headings, lists and links — tables with header cells, images with alt
  text, figures, math — is Typst's job: with `--pdf-standard ua-1` it **refuses to compile**
  an image or figure without alt text. Follow Typst's accessibility guide for those.

## Pitfalls

- **HTML → Chrome print** (the `resumed`/`resume-cli` + puppeteer path, and "Save as PDF"):
  Chrome embeds any **variable** web font — Google Fonts' CSS API serves variable files even
  for fixed weights — as **Type 3**; theme CSS letter-spacing splits headings into letters;
  a theme's print CSS can override the margins you pass in. Of the HTML themes trialled for a
  JSON Resume, none had a clean text layer AND correct dates; one failed export entirely.
- **A tagged PDF does not save a position-based reader.** Tags fixed screen-reader order while
  `pdftotext` still read a sidebar wrongly (86–95 order inversions). Verify text, not tags.
- **Tuning two columns is luck, not design.** Gutter width, heading sizes and spacing were
  swept: 4 of 30 configurations read in order, with no monotonic pattern. Single column, or
  gate every build.
- **Blank lines between sections are not in a PDF.** Preview's copy never emits them, even for
  the PDF Association's reference two-column file; `pdftotext` infers them from gaps. Do not
  try to fake them with invisible text — ATS treat hidden text as keyword stuffing.
- **`pdfinfo -struct-text` emits raw UTF-16 attribute bytes**: decode leniently or it crashes.
- **An order checker can lie both ways.** A marker matched anywhere (not at line start) gave a
  false FAIL; read the reported order before trusting a PASS or a FAIL.

## References

- PDF Association, technique G4_03 *Content in columns correctly ordered* (PDF/UA-1, CC-BY) —
  the reference for a correctly ordered two-column PDF; pdfa.org is Cloudflare-gated, so fetch
  it in a real browser.
- Typst docs: PDF export / `pdf-standard`, `sys.inputs`, `json`, and the accessibility guide
  (tables, alt text, `pdf.artifact`, language). Typst 0.14 made tagging the default and checks
  PDF/UA-1 at export; Posit's Quarto team found veraPDF caught nothing Typst had not.
- Matterhorn Protocol 1.1 (PDF Association) — which PDF/UA checks are machine vs human.
- Adjacent prior art, not used here: Inclusio (LaTeX tagpdf + veraPDF + MCP server; no machine
  order check), the Community-Access veraPDF MCP server, layout-derived reading-order
  remediation skills (for retagging PDFs you did not author).
- veraPDF (PDF/UA-1 validation), poppler `pdftotext`/`pdffonts`.
- Worked example — a JSON Resume theme built this way, with its gate in CI:
  `github.com/ismailkattakath/agentic-jobseek` (`theme/`, `scripts/theme-check.py`,
  `docs/adr/0005-own-theme.md`).
