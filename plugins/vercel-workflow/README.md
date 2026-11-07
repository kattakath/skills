# vercel-workflow

Three skills for Vercel's [Workflow SDK](https://github.com/vercel/workflow), **vendored
unmodified** from [vercel/workflow](https://github.com/vercel/workflow) (Apache-2.0).

| Skill | What it does |
|---|---|
| `vercel-workflow:workflow` | Writes durable, resumable workflows: steps, retries, sleeps, hooks and webhooks, streaming, and testing. |
| `vercel-workflow:workflow-init` | Installs and configures the SDK in a project where it is not in `node_modules` yet (Next.js, Express, Hono, Fastify, NestJS, Nitro, Nuxt, Astro, SvelteKit, Vite). |
| `vercel-workflow:migrating-to-workflow-sdk` | Ports Temporal, Inngest, Trigger.dev and AWS Step Functions workflows to the SDK. Ships its own `references/` and `evals/` beside its `SKILL.md`. |

The skills are prompt-only: no scripts, no MCP servers. The SDK itself is installed into the
target project by `workflow-init`, not by this plugin.

## Provenance

| | |
|---|---|
| Upstream | <https://github.com/vercel/workflow> |
| Pinned commit | `7153e0973c7244eec8b6b3dd349a83eb96ac9743` (2026-11-06) |
| Upstream paths | `skills/workflow/`, `skills/workflow-init/`, `skills/migrating-to-workflow-sdk/`, copied whole |
| Licence | Apache License 2.0, Copyright 2025 Vercel Inc. — upstream's `LICENSE.md`, shipped byte-identical as [`LICENSE`](LICENSE) |
| NOTICE | Upstream has none (`git ls-tree -r` at the pinned commit), so none is shipped. |
| Modifications | **None** (Apache-2.0 §4(b)). Every skill directory is byte-identical to upstream at the pinned commit (`diff -r` clean, 2026-11-07). This README and `.claude-plugin/plugin.json` are added packaging, not changes to the work. |
| Fetched | 2026-11-07 |

Upstream's `skills/` also holds `migrating-workflow-v4-to-v5`, `migrating-world-v4-to-v5` and
`internal-dev-workbench`; none is vendored, and none of the three vendored skills references
them. Each skill's `metadata.version` in its frontmatter is upstream's own skill version, not
this plugin's. To refresh, re-copy the three directories at a newer upstream commit, update
the SHA here and in `plugin.json`'s description, and bump the plugin `version`.

## One change from installing upstream directly

Inside a plugin, a skill is invoked as `<plugin>:<skill>`, so `workflow` becomes
`vercel-workflow:workflow`. The skill directory names are kept identical to upstream, so only
the `vercel-workflow:` prefix is new.
