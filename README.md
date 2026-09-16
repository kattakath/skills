# kattakath/ai

A [Claude Code](https://code.claude.com/docs) plugin marketplace.

## Install

```bash
/plugin marketplace add kattakath/ai
/plugin install page-lab@kattakath
/plugin install llmstxt@kattakath
/plugin install foundation-audit@kattakath
/plugin install claude-code-nix@kattakath
/plugin install superhook@kattakath
```

## Plugins

| Plugin | What it does |
|---|---|
| [`page-lab`](plugins/page-lab) | Author Violentmonkey userscripts and diagnose live pages from one place — a measure-before-you-select method, a two-way element picker driven over the Chrome DevTools Protocol, performance/network/console diagnosis, and a Greasy Fork readiness linter. |
| [`llmstxt`](plugins/llmstxt) | Author spec-compliant [`llms.txt`](https://llmstxt.org) (and the de-facto `llms-full.txt`) from any body of written work — docs, a site, a repo, or a developer accomplishment document. |
| [`foundation-audit`](plugins/foundation-audit) | *Is this repo solid enough to build on?* Four parallel lane-scoped agents — architecture and the boundary violations structural gates cannot see, duplication judged by purpose, activation failure modes classified by **how** they fail, and dead surface including guardrails that match nothing — then an orchestrator that re-verifies the top findings itself. |
| [`claude-code-nix`](plugins/claude-code-nix) | Hooks for working in a Nix-managed repo: auto-stage `.nix` writes so a flake evaluation sees them, and reject hardcoded `/Users/<name>` home paths in Nix values. |
| [`superhook`](plugins/superhook) | Supervising dispatcher for command-type hooks: crash safety so a throwing hook can never wedge a session, and a 3-strikes loop breaker so a mis-firing gate cannot trap an agent forever. |

Each plugin's own `README.md` carries its commands, skills and design notes.

## Using it from Nix

These plugins are consumed declaratively by
[`kattakath/nix-config`](https://github.com/kattakath/nix-config) as a pinned
source-only flake input, rather than installed imperatively:

```nix
# flake.nix
kattakath-ai = {
  url = "github:kattakath/ai";
  flake = false;
};
```

```nix
# modules/shared/home.nix — registered from the input's STORE PATH, never a
# path literal: a store path is absolute, so it means the same thing from any
# file in any flake.
local.claudePlugins.marketplaces.kattakath = {
  source = "${kattakath-ai}";
  plugins = [ "page-lab" "llmstxt" "foundation-audit" ];
};
```

The pin lives in `flake.lock` and is bumped with `nix flake update`, so an
activation is reproducible and needs no network fetch of its own. Non-Nix users
get the same content through `/plugin marketplace add` above.

## Scripts are the source of truth for rules

`page-lab/scripts/userscript-meta-lint.sh` is the single Greasy Fork rulebook:
it is what the plugin tells you to run, and it is also what
`kattakath/nix-config`'s `checks.<system>.userscripts` gate executes in CI. One
rulebook, so the plugin's users and the fleet's CI cannot drift apart.

## License

MIT — see [LICENSE](LICENSE).
