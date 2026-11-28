# markup-lsp's flake: builds servers.nix (the one package list) and checks it against .lsp.json.
#
#   nix build ./plugins/markup-lsp            → result/bin/<every server .lsp.json names>
#   nix profile install ./plugins/markup-lsp  → the same, on PATH, for a machine without its own Nix config
#   nix flake check ./plugins/markup-lsp      → `commands`: every .lsp.json command is a bin/ of the list
#
# The nixpkgs pin here only serves standalone installs and CI. A consumer that imports
# servers.nix into its own config (Home Manager) builds it on ITS pin instead.
{
  description = "markup-lsp — YAML, TOML, JSON, HTML, CSS, XML and Markdown language servers for Claude Code";

  inputs.nixpkgs.url = "https://flakehub.com/f/DeterminateSystems/nixpkgs-weekly/0.1";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      lsp = builtins.fromJSON (builtins.readFile ./.lsp.json);
      commands = nixpkgs.lib.unique (map (s: s.command) (builtins.attrValues lsp));
      env =
        pkgs:
        pkgs.buildEnv {
          name = "markup-lsp-servers";
          paths = import ./servers.nix { inherit pkgs; };
        };
    in
    {
      packages = forAll (pkgs: {
        default = env pkgs;
      });

      checks = forAll (pkgs: {
        commands = pkgs.runCommand "markup-lsp-commands" { } ''
          missing=0
          for c in ${pkgs.lib.escapeShellArgs commands}; do
            if [ -x "${env pkgs}/bin/$c" ]; then
              echo "ok      $c"
            else
              echo "MISSING $c — .lsp.json names it, servers.nix does not provide it" >&2
              missing=1
            fi
          done
          [ "$missing" = 0 ] && touch "$out"
        '';
      });
    };
}
