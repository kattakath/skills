# FACTS — source of truth for "<working title>"

Everything here was observed or verified against the cited source. Tags: [measured] =
observed (give the PR / commit / run / timestamp); [source] = cited (give the URL);
[inferred] = reasoning. Date any figure that changes (stars, counts) — "as of YYYY-MM-DD".
Name the checkout path writers may read files from.

## A. The setting
<Repos, systems, people (by role unless they are the author), constraints, the author's
stated goals, mottos or framing — quoted where the wording matters.>

## B. Chronological discovery log
<One numbered entry per turning point: goal → what happened → what broke → lesson → result
(PR/commit/time). Keep the dead ends; they are the most useful part.>

## C. Change ledger
<Table built from the records, never from memory, e.g.:
`gh pr list --state merged --json number,title,mergedAt,mergeCommit,mergedBy`>

| PR | Commit | Merged at (UTC) | Merged by | What |
|---|---|---|---|---|

## D. Research findings
<Each item verified this session: title, date, id/URL, the specific finding used. Mark the
verification method (API, file read). Unverified items are left out, not tagged.>

## E. The resulting system
<Files, versions, settings, and how it is delivered.>

## F. Distilled lessons
<Numbered, each ending with the B-entry it comes from: "… (B5)".>
