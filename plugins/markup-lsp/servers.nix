# The ONE list of language-server packages behind this plugin's `.lsp.json`.
#
# Two readers, one list:
#   - this plugin's flake.nix (`packages.default`, and the `commands` check that every
#     `command` in .lsp.json is a bin/ of this list);
#   - a consumer's own Nix config, e.g. Home Manager:
#       home.packages = import "${inputs.kattakath-skills}/plugins/markup-lsp/servers.nix" { inherit pkgs; };
#     That puts the bare commands on PATH under the consumer's own nixpkgs pin.
#
# Plain nixpkgs, no overrides. One was measured and REJECTED (2026-11-28, aarch64-darwin,
# nixpkgs d5cc6833): stock `marksman` and its dotnet-runtime-9.0.22 are both substitutable
# from cache.nixos.org, while overriding `dotnetCorePackages.runtime_9_0` to `runtime_9_0-bin`
# changes marksman's hash and turns that cache hit into a local source build (dotnet-sdk,
# NuGet restore, xunit). tests/run.sh --cache is the gate: it fails if a dry-run on this
# system would build anything but the buildEnv.
{ pkgs }:
with pkgs;
[
  yaml-language-server # `yaml-language-server --stdio` — .yaml/.yml
  taplo # `taplo lsp stdio` — .toml
  vscode-langservers-extracted # `vscode-{json,html,css}-language-server --stdio`
  lemminx # `lemminx` (stdio by default) — .xml/.xsd/.xsl
  marksman # `marksman server` — .md
]
