# Evidence behind ats-safe-pdf

Measured 2026-11-02 on a 5-page JSON Resume (8 skill groups, 7 jobs, 4 projects), Typst 0.15.1,
veraPDF 1.30.2, poppler `pdftotext`, macOS PDFKit (Preview copy), and the tag tree read with
`qpdf --json`. "Inversions" = pairs of section/entry markers read in the wrong order.

## The four readers disagree

| Reader | Order it uses | Who reads this way |
|---|---|---|
| `pdftotext` | positions on the page | most ATS parsers, many PDF-to-text libraries |
| `pdftotext -raw` | stored drawing order | stream-order parsers |
| PDFKit | drawing order | macOS Preview select-all + copy |
| tag tree | `/StructTreeRoot` | screen readers, tag-aware tools |

## Layouts

| Layout | pdftotext | raw / PDFKit | tags |
|---|---|---|---|
| Right sidebar spanning pages | 86–95 inversions | wrong | right |
| Left sidebar ending on page 1 | 10 inversions — two headings shared a baseline | in order | in order |
| Full-height two-column grid, sidebar on p1 only, small sidebar type | in order | in order | in order |
| …same, sidebar content grows past page 1 | 12 inversions | 12 inversions | in order |
| …same, bigger headings put the name and the first main heading on one line | the whole summary read between the title and the contact block; name and heading merged into one line | in order | in order |
| Page-1 sidebar, full width after (content split by measurement) | in order; p2+ lines ~130 characters | in order | a list split across the page break became two lists |
| Two flowing (newspaper) columns | 2–3 inversions at a column top | in order | in order |
| …gutter 18→48pt, heading pairs, space above headings 0.5–2.5 lines | 4 of 30 configurations in order, non-monotonic | — | — |
| **Single column** | **in order** | **in order** | **in order** |

## Text-layer defects

| Defect | Where seen | Fix that removed it |
|---|---|---|
| "labelproof", "eventdriven" (hyphen at line end) | pdftotext | box hyphen compounds; hyphenation off |
| "Python/ FastAPI" | every reader | box slash compounds |
| "~ 480" split | every reader | box takes a leading `~` |
| "Acme CorpMar 2026" (8 entries) | PDFKit only | heading→next-line gap from ~2pt to ~6pt |
| "S U M M A R Y" | HTML theme with letter-spacing | no tracking on headings; the checker then found all sections |
| Type 3 fonts | Chrome with any variable web font | static font files (CID TrueType) |
| Serif fallback for "→" | static Roboto 3 lacks U+2192 | a fallback font that has it, or check `pdffonts` |
| Footer text in every copy | all extractors, despite artifact tagging | omit footers, or accept the noise (ATS scores were identical with and without) |

## ATS checkers, same résumé content

| Render | Reactive Resume | Jobalytics match / overall / sections / essentials |
|---|---|---|
| HTML theme (letter-spaced headings) via Chrome | 60 | 63 / 68 / 70 / 88 |
| Typst, one column, before the fixes above | 100 | 59 / 83 / 100 / 100 |
| Typst, two-column sidebar | 98 ("lines packed very tightly") | 62 / 80 / 87 / 100 |
| **Typst, single column, all fixes** | **99** (only: visible link text omits `https://`) | **63 / 83 / 100 / 100** |

- Reactive Resume flagged "no accessibility tags" on a veraPDF-PASS file once and not on its
  twin — its tag check is unreliable; trust veraPDF.
- Jobalytics essentials: the same PDF scored 92 as `…-M3Final.pdf` and 100 as `<Name>-<Role>.pdf`.
- Keyword match tracks content, not layout: it barely moved across every render.

## Line length

- Guidance: Bringhurst 45–75 (66 ideal); WCAG 2.x SC 1.4.8 (AAA) ≤ 80; Baymard 50–75;
  Butterick 45–90. Ling & van Schaik (2006, n ≈ 72/98): best accuracy at ~70 characters per
  line; longer lines only slightly faster for visual search. No study tested beyond 100.
- Measured at 10.5pt body: 0.55in side margins → median 103 / p90 132 CPL; 1in → median 85–87.
