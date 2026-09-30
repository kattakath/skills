# BRIEF — "<working title>"

You are producing (part of) ONE document. Read this whole brief before writing anything.
The companion file `FACTS.md` (same directory) is the **only source of truth** for what
happened, what was measured and what the research says. Do not invent numbers, dates, PR
numbers, star counts, quotes or links that are not in FACTS.md or in a file you actually read.

## 1. What the document is

<One paragraph: the discovery, stated as a claim a reader can test.>

> <The core idea in one or two sentences, quotable.>

<Framing the author asked for, e.g. "the metaphor is illustrative, not literal".>

Working title: **"<title>"** (subtitle: "<subtitle>"). Improve it if a better one emerges.

## 2. Audiences, in priority order

1. **AI agents** that will generate derivative content from this document (social posts,
   articles, READMEs, video scripts, slides, animations). So: maximally explicit and
   self-contained, every claim labelled, every number sourced, every section opening with a
   one-line summary, stable headings, no "as mentioned above" without a link.
2. **Practitioners** trying to apply the discovery. <Name them.>
3. The author, as a record.

## 3. Format rules (hard)

- GitHub-flavoured Markdown. One H1. Numbered H2 sections. Stable, descriptive headings.
- **Diagrams: plain ASCII / box-drawing first** (small, captioned, ≤ 70 columns). A
  ```` ```mermaid ```` fence only when ASCII cannot carry it (many actors, state machines,
  long timelines).
- Tables for comparisons, mappings, ledgers and decisions. Bullets over paragraphs;
  paragraphs ≤ 4 sentences.
- Callouts as blockquotes with a bold label: `> **Key insight:**`, `> **Pitfall:**`,
  `> **Measured:**`, `> **Note:**`, `> **Why not X?**`.
- **Evidence tags** on every non-obvious claim: `[measured]` (observed, with its PR, commit,
  run or time), `[source]` (cited and linked), `[inferred]` (reasoning). Never upgrade one.
- Full URLs; absolute dates (YYYY-MM-DD); no hype words; no emoji outside a table legend.

## 4. Required structure

0. Front matter (YAML: title, subtitle, date, version, author, repo, audiences, 15–25
   keywords, `for_agents` reuse notes, licence suggestion)
1. TL;DR (5–7 bullets + one ASCII diagram of the whole idea)
2. Highlights (8–12 quotable, tagged facts)
3. Problem statement
4. The idea
5. Architecture / how it fits together (diagrams)
6. The discovery log (timeline, dead ends included)
7. Component deep dives <list them>
8. Why this, not that (≥ 12 decision records as Q&A) <seed the questions>
9. Prior art and research (tables; formal framings; what goes wrong)
10. Where to start (staged on-ramp; solo and team)
11. Where to find things (link directory by purpose)
12. Pitfalls and gotchas (symptom → cause → fix → evidence)
13. FAQ (12–20)
14. Metrics and evidence ledger
15. Open questions and roadmap
16. Content kit for derivative media (core message, taglines, per-channel outlines:
    LinkedIn, X thread, long-form article, video beats with timestamps, 10–12 slides,
    3 animation storyboards from the diagrams, README blurb; visual motifs; claim rules)
17. Glossary
18. Appendix (A: change ledger; B: command cheat-sheet; C: file map; D: how this document
    was produced and how to regenerate it)

Drop a section only if FACTS.md has nothing for it, and say so in Appendix D.

## 5. Quality bar

- Every section opens with a one-line italic summary.
- Every number traceable to FACTS.md, and through it to a record.
- No contradictions between sections; the glossary is authoritative for terms.
- Honest about limits: sample size, single-author evidence, dates of any star counts.
- Long and complete, no padding.
