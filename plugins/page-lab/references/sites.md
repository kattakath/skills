# Site register — the aliases `facts.md` measures against

Every fact in [`facts.md`](facts.md) is measured on a real site, and the measurement is only
re-runnable if the *kind* of site is known. This file supplies that without naming domains:
**`facts.md` carries the SHAPE, this file carries the VALUES.**

A fact says `SITE-D` and this register says what `SITE-D` is made of. That is enough to judge
whether a fact applies to the site in front of you, which is the only thing the fact is for.

## Why the aliases exist

The sites these scripts target are **personal**, not public. A public repository under a
named author should carry the method and the browser behaviour — both genuinely reusable —
without also carrying a dated record of which sites were opened and when. The method loses
nothing: of the facts here, the large majority are browser behaviour that is true everywhere
(a transparent background is not black; a zero-size element cannot take focus; a cold profile
boots slowly). Only a handful depend on a specific site's markup, and for those the stack
description below is what actually carries the information.

## The register

| Alias | Stack, as measured |
|---|---|
| **SITE-A** | Legacy float/grid video wall. **Two unrelated page shells** — different markup, ids and classes for the same content. Dark-navy stock ground. Cards at `/video-<id>/<slug>`; one URL shape serves the same cards through an **opaque redirect** instead. Hand-authored class names throughout. |
| **SITE-B** | Same operator and near-identical markup to SITE-A. Cards at `/video.<id>/<slug>` — **one character apart**, which is enough to make a gate written for one score zero on the other. `body` carries 80px inline padding. Its dark theme is a **stored user preference** with zero `prefers-color-scheme` blocks. |
| **SITE-C** | Float-based grid whose container **computes `height: 0`** while its children paint — a collapsed float container. Hand-authored class names. Light stock ground, so a theme is genuinely needed. |
| **SITE-D** | Hash-classed SPA: most class names carry a **build hash**, some blocks have no class at all, and one hashed class stopped matching **between two loads minutes apart**. Lazily-rendered grid. `header` computes **`display: contents`**. Ships its own dark theme, which shifts with `prefers-color-scheme`. |
| **SITE-E** | Ambiguous class signatures — **seven containers share one string**, which is what makes a signature unusable as a selector. |

## Supplying real values, privately

This register is deliberately domain-free. An operator who wants the aliases resolved to real
hosts supplies them **locally**, outside this repository:

```
~/.claude/page-lab/sites.local.md
```

Anything there is a **values overlay**: it may map an alias to a host and add notes, and it
may not change any fact, ID or recipe. The shape stays here, in the pinned plugin; the local
file only fills it in. If the file is absent — the normal case — every fact still reads
correctly, because the stack description above is what the fact actually depends on.

**Do not copy real hosts into this file, into `facts.md`, or into any skill.** A fact that
needs a host to make sense is a fact whose stack description is not yet good enough; fix the
description rather than naming the site.
