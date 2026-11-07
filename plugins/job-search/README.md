# job-search

Five job-application skills, **vendored unmodified** from
[Paramchoudhary/ResumeSkills](https://github.com/Paramchoudhary/ResumeSkills) (MIT).

| Skill | What it does |
|---|---|
| `job-search:job-description-analyzer` | Breaks a posting into requirements, scores the match against a resume, names the gaps, and suggests an application strategy. |
| `job-search:resume-ats-optimizer` | Checks a resume for ATS (Applicant Tracking System) compatibility and keyword match against a posting. |
| `job-search:cover-letter-generator` | Drafts a personalized cover letter from a resume and a job description. |
| `job-search:interview-prep-generator` | Builds STAR stories, likely questions and talking points from a resume. |
| `job-search:salary-negotiation-prep` | Researches market rates, builds a negotiation strategy, and writes counter-offer scripts. |

The skills are prompt-only: no scripts, no MCP servers, nothing to install.

## Provenance

| | |
|---|---|
| Upstream | <https://github.com/Paramchoudhary/ResumeSkills> |
| Pinned commit | `74ae19e7c62b0516d1c298328e5544976c12da5d` (2026-06-19) |
| Upstream paths | `skills/<name>/` for each skill above, copied whole |
| Licence | MIT, Copyright (c) 2026 Resume Skills — upstream's [`LICENSE`](LICENSE), shipped byte-identical |
| Modifications | **None.** Every skill directory is byte-identical to upstream at the pinned commit (`diff -r` clean, 2026-11-07). |
| Fetched | 2026-11-07 |

Upstream ships 22 skills; only these five are vendored. To refresh, re-copy `skills/<name>/`
at a newer upstream commit, update the SHA here and in `plugin.json`'s description, and bump
the plugin `version`.

## One change from installing upstream directly

Inside a plugin, a skill is invoked as `<plugin>:<skill>`, so `cover-letter-generator` becomes
`job-search:cover-letter-generator`. The skill directory names are kept identical to upstream,
so only the `job-search:` prefix is new.
