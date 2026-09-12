# kattakath/claude-plugins

A [Claude Code](https://code.claude.com/docs) plugin marketplace.

## Install

```bash
/plugin marketplace add kattakath/claude-plugins
/plugin install page-lab@kattakath
/plugin install llmstxt@kattakath
```

## Plugins

| Plugin | What it does |
|---|---|
| [`page-lab`](plugins/page-lab) | Author Violentmonkey userscripts and diagnose live pages from one place — a measure-before-you-select method, a two-way element picker driven over the Chrome DevTools Protocol, performance/network/console diagnosis, and a Greasy Fork readiness linter. |
| [`llmstxt`](plugins/llmstxt) | Author spec-compliant [`llms.txt`](https://llmstxt.org) (and the de-facto `llms-full.txt`) from any body of written work — docs, a site, a repo, or a developer accomplishment document. |

Each plugin's own `README.md` carries its commands, skills and design notes.

## Using it from Nix

These plugins are consumed declaratively by
[`kattakath/nix-config`](https://github.com/kattakath/nix-config) as a pinned
source-only flake input, rather than installed imperatively:

```nix
# flake.nix
kattakath-claude-plugins = {
  url = "github:kattakath/claude-plugins";
  flake = false;
};
```

```nix
# the marketplace is registered from the input's store path
local.claudePlugins.marketplaces.kattakath = {
  source = "${inputs.kattakath-claude-plugins}";
  plugins = [ "page-lab" "llmstxt" ];
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
