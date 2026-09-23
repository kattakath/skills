# kattakath/skills

Agent skills and [Claude Code](https://code.claude.com/docs) plugins by Ismail Kattakath.

- `skills/` holds standalone [Agent Skills](https://agentskills.io): one folder per skill, each with a `SKILL.md`.
- `plugins/` holds Claude Code plugins that bundle skills with commands, agents, hooks or output styles.
- `.claude-plugin/marketplace.json` publishes both as the `kattakath` marketplace.

## Install

```bash
/plugin marketplace add kattakath/skills
/plugin install <name>@kattakath
```

To pick up new commits on your next session, open `/plugin` → Marketplaces → `kattakath` → **Enable auto-update**. Plugins here carry no `version`, so each commit on `main` is a new version.

## Contents

Looking for a way to do something? Start at [INDEX.md](INDEX.md): goal → route, pointing to
outside sources first and to what's here only where nobody else has charted it.

| Name | What it does |
|---|---|
| [`claude-code-nix`](plugins/claude-code-nix) | Hooks for working on Nix flakes with Claude Code: auto-stage .nix writes so flake evaluation sees them, and flag hardcoded per-user home paths in .nix values. |
| [`foundation-audit`](plugins/foundation-audit) | Four-dimension foundation audit of a config monorepo — architecture and the boundary violations structural gates structurally cannot see, duplication judged by purpose, activation failure modes classified by how they fail, and dead surface including guardrails that match nothing. |
| [`llmstxt`](plugins/llmstxt) | Author spec-compliant llms.txt (and the de-facto llms-full.txt) from any body of written work — docs, a site, a repo, or a developer accomplishment document. |
| [`page-lab`](plugins/page-lab) | Author Violentmonkey userscripts and diagnose live pages from one place — a measure-before-you-select method, a two-way element picker driven over the Chrome DevTools Protocol, a config-driven redesign acceptance runner that injects at document-start across real navigations and exercises the result with trusted events, performance/network/console diagnosis, and a Greasy Fork readiness linter, and a multi-agent method for redesigning a whole site. |
| [`superhook`](plugins/superhook) | Supervising dispatcher for command-type Claude Code hooks: crash safety so a throwing hook can never wedge a session, and a 3-strikes loop breaker so a mis-firing gate cannot trap an agent forever. |
| [`mac-app-send`](plugins/mac-app-send) | Drive a native macOS app with the computer-use MCP to send a formatted message and attach files. |
| [`rag`](skills/rag) | Retrieval-augmented generation over a local pgvector store: ingest documents, then answer questions from that corpus. |
| [`android-phone`](skills/android-phone) | Connect and operate a physical Android device over ADB, wired or wireless: pairing, connecting, TCP/IP bootstrap and scrcpy mirroring. |
| [`nix-dev-toolkit`](skills/nix-dev-toolkit) | Make a repo self-contained with a Nix flake for development, deployment and maintenance: dev shells, local Postgres with pgvector, self-hosted runners, and an env-var catalogue. |
| [`capability-broker`](skills/capability-broker) | When a goal needs a capability the session lacks: take stock of what is installed, find and vet candidates (MCP servers, skills, plugins, tools), and adopt the least powerful one that works. |
| [`harvest`](skills/harvest) | At the end of a task worth repeating: pick the right artifact type (skill, agent, workflow), strip anything machine- or secret-specific, and write it in the standard format. |
| [`jsonresume-tailor`](skills/jsonresume-tailor) | Tailor a JSON Resume (resume.json) to a specific job posting without fabricating anything, then validate it and render a PDF. |
| [`github-release-gate`](skills/github-release-gate) | Make the default branch a safe release: require the CI check with a ruleset first, then allow auto-merge and arm it on same-repo PRs only, verifying each step against GitHub. |
| [`brain-signals`](plugins/brain-signals) | An answer-shape kit for scannable, verdict-first answers: the Brain Signals output style, the /explain family (explain, compare, map, zoom, why, tldr, diagram), a read-only cartographer subagent for architecture maps, and /task for goal-locked execution. |

Each plugin's own `README.md` covers its commands, skills and design notes.

## Scripts are the source of truth for rules

`plugins/page-lab/scripts/userscript-meta-lint.sh` is the single Greasy Fork rulebook. It is what the plugin tells you to run, and it is what userscript repositories run in their own CI.

## License

MIT — see [LICENSE](LICENSE).
