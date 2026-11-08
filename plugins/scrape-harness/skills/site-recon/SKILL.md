---
name: site-recon
description: Study a NEW site before writing its Source — robots, page kinds, expected selectors, pagination, gates — from a handful of operator-approved pages, ending in a Source stub, synthetic fixtures and a pipeline.toml. Use when the operator asks to add a site or start a new consumer.
---

# Site recon: phases with gates (adapted from yfe404/web-scraper's recon flow, MIT)

Each phase ends at a gate the operator passes. Nothing here crawls; every page is a planned,
approved request through the CLI, or one the operator saves himself.

| Phase | Output | Gate |
|---|---|---|
| 0 Purpose | the question the data must answer; what is out of scope | operator states it |
| 1 Rules | robots.txt + terms read; rate ceiling; what must never be fetched | operator agrees the ceiling |
| 2 Page kinds | list / detail / gate / challenge page shapes, from ≤ 5 saved pages | pages saved by the operator, outside the repo |
| 3 Contract | observation.v1/listing.v1 for this site, on the core floor (see `interfaces.Source`) | schemas validate examples + invalid cases |
| 4 Source + fixtures | `parse_list` / `parse_ad`, `expect` selectors, `coverage_fields`; SYNTHETIC fixtures that mirror the structure with invented values | Source tests green |
| 5 Pipeline | the consumer's pipeline.toml: `[consumer]` names, stages, network classes, files | the goldens recorded deliberately, `nix flake check` green |

Fixtures are always synthetic: invented names, ids, prices, `.invalid` URLs and coordinates in open
ocean. A real page, id, URL, phone number or coordinate never enters the repo (the hooks block it).
