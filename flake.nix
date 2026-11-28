# kattakath/skills on the fleet's shared repo shape (github:ismailkattakath/repo-kit).
#
#   nix develop           → git (the marketplace's own checks run through npx/python3; CLAUDE.md
#                           § Validating before you push)
#   nix fmt               → treefmt (nixfmt) over this flake only — never plugins/**
#   nix flake check       → treefmt + toolchain-complete + the generated-file drift checks
#   nix run .#write-files → regenerate LICENSE, .envrc, .editorconfig, devcontainer.json,
#                           .github/dependabot.yml
#
# A lean flake on purpose: its only job is the generated files. The plugins' `.nix` assets are
# TEMPLATES (validate.yml parses them, it cannot evaluate them), so the formatter must not
# touch them — and anything under plugins/ ships to every install through `stable`.
{
  description = "kattakath/skills — the kattakath Claude Code plugin marketplace";

  inputs = {
    repo-kit.url = "github:ismailkattakath/repo-kit";
    nixpkgs.follows = "repo-kit/nixpkgs";
    flake-parts.follows = "repo-kit/flake-parts";
  };

  outputs =
    inputs@{ flake-parts, repo-kit, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [ repo-kit.flakeModules.default ];

      repoKit = {
        name = "skills";
        license = {
          spdx = "MIT";
          year = "2026";
          holder = "Ismail Kattakath";
        };
        # .github/dependabot.yml, generated: GitHub Actions only, weekly, one group, 7-day
        # cooldown. Every action here is SHA-pinned (a `# vX` comment for readability, the
        # `uses:` line takes the SHA), including anthropics/claude-plugins-community's
        # validate-plugins action, whose own RELEASING.md requires a commit pin: a mutable ref
        # would let anyone who can push to that repo run code in this repo's CI. Left alone,
        # pins rot silently; Dependabot bumps them and its PR goes through `validate` and the
        # ruleset before it merges.
        dependabot.enable = true;
      };

      perSystem =
        { pkgs, ... }:
        {
          repoKit = {
            devPackages = [ pkgs.git ];
            requiredBins = [ "git" ];
          };

          treefmt.settings.global.excludes = [ "plugins/**" ];
        };
    };
}
