# Packages that provide the commands named in .lsp.json (the file extensions live there too).
#
# Read by flake.nix here and, unchanged, by any Nix config that wants the commands on PATH:
#   home.packages = import "${inputs.kattakath-skills}/plugins/markup-lsp/servers.nix" { inherit pkgs; };
# Stock nixpkgs attributes only; README.md § Cache records why marksman is not overridden.
{ pkgs }:
with pkgs;
[
  yaml-language-server
  taplo
  vscode-langservers-extracted
  lemminx
  marksman
]
