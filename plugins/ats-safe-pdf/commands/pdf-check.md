---
description: Check any PDF's text layer — fonts, PDF/UA-1 conformance, and reading order in position, drawing and tag order
argument-hint: "<file.pdf> [--markers FILE] [--once FILE]"
---

Check the PDF named in `$ARGUMENTS` with the **ats-safe-pdf** skill
(`${CLAUDE_PLUGIN_ROOT}/skills/ats-safe-pdf/SKILL.md`, step 5). It works on a PDF from any
generator — Typst, a browser's print-to-PDF, reportlab, Word — not only one this skill built.

## Sequence

1. **Fonts** — `pdffonts <pdf>`. Report any `Type 3` font and any family the author did not
   intend (a silent fallback).
2. **Conformance** — if `verapdf` is on PATH: `verapdf --flavour ua1 --format text <pdf>`.
   Report PASS/FAIL with the failed rule clauses. If it is absent, say so; do not install it.
3. **Reading order** — `python3 ${CLAUDE_PLUGIN_ROOT}/skills/ats-safe-pdf/scripts/pdf-text-check.py`
   on the PDF. No `--markers` given? Build one from the document itself: read the source if
   there is one (the Typst/HTML/JSON it came from) and list its headings and entry titles in
   source order; otherwise ask the user for the intended section order. Never derive the
   expected order from the PDF under test — that checks the file against itself.
4. **Preview copy (macOS only)** — `swift ${CLAUDE_PLUGIN_ROOT}/skills/ats-safe-pdf/scripts/pdfkit-text.swift <pdf>`
   and skim the first screen for glued headings ("CompanyMar 2026").

## Report

A table: check · result · the evidence line (failed clause, inversion list, split word). Then
one verdict line: **safe to send**, or the single highest-impact fix. Remember what no tool
settles: whether a tag is the right *kind* (a real heading?) and whether alt text is
meaningful are human judgements (Matterhorn's human-only checkpoints).
