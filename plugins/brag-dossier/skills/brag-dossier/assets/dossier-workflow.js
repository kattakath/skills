export const meta = {
  name: 'brag-dossier',
  description: 'Write, fact-check, assemble and critique a discovery dossier from BRIEF.md + FACTS.md',
  phases: [
    { title: 'Write', detail: '9 section writers in parallel' },
    { title: 'Verify', detail: 'adversarial fact-check per section, corrected in place' },
    { title: 'Assemble', detail: 'one document, consistent terms and numbers' },
    { title: 'Critique', detail: 'completeness critic + fixer' },
  ],
}

const D = args.dir
const OUT = args.out
const COMMON = `Read ${D}/BRIEF.md and ${D}/FACTS.md in full first. FACTS.md is the only source of truth for events, numbers, dates, PRs, stars and links; the repo at /workspaces/skills may be read for file contents (skills/*/SKILL.md, INDEX.md, index/*.json, scripts/, .github/workflows/). Follow the BRIEF's format rules exactly: ASCII/box-drawing diagrams first (<=70 cols, captioned), mermaid only when ASCII can't carry it, evidence tags [measured]/[source]/[inferred] on factual claims, full URLs, absolute dates, one-line italic summary under each section heading. Do NOT use the network except to read files already referenced; do NOT modify anything under /workspaces/skills.`

// args.sections overrides this split; keep ids zero-padded and in document order.
const DEFAULT_SECTIONS = [
  { id: '01', title: 'Sections 0-4: Front matter (YAML), 1 TL;DR, 2 Highlights, 3 Problem statement, 4 The idea', extra: 'The TL;DR carries one ASCII diagram of the whole idea. Highlights: 8-12 quotable facts, each tagged.' },
  { id: '02', title: 'Section 5: Architecture', extra: 'ASCII diagrams of the components and how they connect, plus a component table (role, file path, version).' },
  { id: '03', title: 'Section 6: The discovery log', extra: 'FACTS section B as a timeline table (time, goal, what happened, lesson, result) plus prose per turning point, and one timeline diagram. Keep the dead ends.' },
  { id: '04', title: 'Section 7: Component deep dives', extra: 'Read each component\'s actual files; purpose, how it works, key rules, evidence, paths.' },
  { id: '05', title: 'Section 8: Why this, not that', extra: 'At least 12 decision records as Q&A: question, decision, why, alternatives rejected, evidence tag. Use the questions seeded in the BRIEF.' },
  { id: '06', title: 'Section 9: Prior art and research', extra: 'Tables per source kind (academic, first-party vendor, open source), formal framings with a mapping table, and what the evidence says goes wrong.' },
  { id: '07', title: 'Sections 10-11: Where to start, Where to find things', extra: 'Staged on-ramp (day 1, week 1, month 1; solo and team) with concrete commands from FACTS, an ASCII decision tree, and a link directory grouped by purpose.' },
  { id: '08', title: 'Sections 12-14: Pitfalls and gotchas, FAQ, Metrics and evidence ledger', extra: 'Pitfalls as symptom -> cause -> fix -> evidence (measured first); 15-20 FAQs; a ledger table of every measured number with its source.' },
  { id: '09', title: 'Sections 15-18: Open questions and roadmap, Content kit for derivative media, Glossary, Appendix A-D', extra: 'The content kit covers every channel the BRIEF lists plus a strict do/don\'t list for claims; glossary of 25+ terms; appendix D says how the document was produced and how to regenerate it.' },
]
const SECTIONS = args.sections || DEFAULT_SECTIONS

const ISSUES = { type: 'object', properties: {
  path: { type: 'string' },
  corrections: { type: 'array', items: { type: 'string' } },
  unverifiable_removed: { type: 'array', items: { type: 'string' } },
}, required: ['path', 'corrections', 'unverifiable_removed'] }

phase('Write')
const verified = await pipeline(
  SECTIONS,
  s => agent(`${COMMON}

You are writing ONLY: ${s.title}.
${s.extra}
Write the section(s) as final-quality Markdown (starting at the H2 heading(s), numbered as in the BRIEF's required structure; the front-matter writer also produces the H1 title and the YAML block). Save it to ${D}/sections/${s.id}.md using the Write tool (create the directory if needed). Return just the path.`, { label: `write:${s.id}`, phase: 'Write' }),
  (_, s) => agent(`${COMMON}

You are an adversarial fact-checker for ${D}/sections/${s.id}.md (${s.title}). Assume it contains errors. Check EVERY number, date, time, PR number, commit hash, star count, version, threshold, quote, link and file path against FACTS.md and the actual files in /workspaces/skills. Check that [measured] is only used for things FACTS marks measured, that no [inferred] claim is presented as fact, that diagrams are ASCII-first, <=70 columns and captioned, and that every section heading has a one-line italic summary. Fix every problem IN PLACE in that file with the Edit tool (remove anything you cannot trace to FACTS.md or a repo file). Then return the path, the list of corrections you made, and the list of unverifiable claims you removed.`, { label: `verify:${s.id}`, phase: 'Verify', schema: ISSUES }),
)
const ok = verified.filter(Boolean)
log(`verified ${ok.length}/${SECTIONS.length} sections; ${ok.reduce((n, v) => n + v.corrections.length, 0)} corrections, ${ok.reduce((n, v) => n + v.unverifiable_removed.length, 0)} removals`)

phase('Assemble')
await agent(`${COMMON}

Assemble the final document from every file in ${D}/sections/ in id order (read all of them) into ONE file at ${OUT} (create the parent directory). Rules:
- Order exactly as the BRIEF's required structure (0-18). One H1. Insert a linked Table of Contents after the TL;DR.
- Reconcile terminology and numbers across sections (one name per concept; the Glossary is authoritative); remove duplicated passages, keeping the best version and cross-linking with relative anchors.
- Keep every diagram, table, evidence tag and reference; do not add new facts.
- Ensure every mermaid block is valid mermaid syntax and every ASCII diagram sits in a plain code fence.
Write the file, then return a one-paragraph summary of what you reconciled.`, { label: 'assemble', phase: 'Assemble' })

phase('Critique')
const GAPS = { type: 'object', properties: { gaps: { type: 'array', items: { type: 'object', properties: {
  where: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } }, required: ['where', 'problem', 'fix'] } } }, required: ['gaps'] }
const critique = await agent(`${COMMON}

You are the completeness and consistency critic for ${OUT}. Compare it against every requirement in BRIEF.md (structure 0-18, format rules, quality bar) and against FACTS.md (is any important fact, lesson in section F, research finding or PR missing? any contradiction between sections? any claim without an evidence tag? any link malformed? any section missing its italic summary? any diagram wider than 70 columns or not captioned? is the content kit complete for every channel listed?). Return the concrete gaps with the exact fix for each. Do not edit the file.`, { label: 'critic', phase: 'Critique', schema: GAPS })
const gaps = (critique && critique.gaps) || []
log(`critic found ${gaps.length} gaps`)
let fixed = 'no gaps'
if (gaps.length) {
  fixed = await agent(`${COMMON}

Apply these fixes to ${OUT} with the Edit tool, adding no fact that is not in FACTS.md or a repo file:
${JSON.stringify(gaps, null, 1)}
Return a short list of what you changed and anything you could not fix and why.`, { label: 'fix-gaps', phase: 'Critique' })
}
return { sections: ok.map(v => ({ path: v.path, corrections: v.corrections.length, removed: v.unverifiable_removed })), gaps, fixed }
