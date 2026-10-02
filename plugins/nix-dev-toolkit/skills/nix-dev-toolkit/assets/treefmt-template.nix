# Sibling of flake-template.nix — copy this in as `treefmt.nix`, beside flake.nix.
#
# It is read from TWO places that must never disagree: `formatter` (what `nix fmt` runs) and the
# `formatting` check (what `nix flake check` fails on) are both built from this one module.
#
# WHY a module instead of `formatter = pkgs.nixfmt-rfc-style`: `nix fmt` hands the formatter the
# WHOLE tree, not just the .nix files. A bare nixfmt therefore dies `unexpected end of input` on
# the first `README.md` it is given — measured. Dispatching per file type is the entire reason
# treefmt exists, and it is why there is no hand-written formatter here to get wrong.
{
  # Anchors treefmt's file walk at the repo root. A file that always exists at the top.
  projectRootFile = "flake.nix";

  # RFC 166 official style. The attribute is `nixfmt` (the package nixfmt-rfc-style took that
  # name upstream); `nixpkgs-fmt` is archived and must not be reached for.
  programs.nixfmt.enable = true;

  # ADAPT — enable only the ones this project actually has files for. Each pulls its formatter
  # into the closure of both `nix fmt` and the check, so an unused one is pure download.
  # programs.prettier.enable = true;   # js / ts / json / css / md / yaml
  # programs.black.enable = true;      # python
  # programs.rustfmt.enable = true;    # rust
  # programs.gofmt.enable = true;      # go
  # programs.shfmt.enable = true;      # sh / bash

  # ADAPT — what no formatter of ours may rewrite. Generated output, lockfiles and vendored
  # trees belong here: the `formatting` check compares the tree against treefmt's own output, so
  # a formatter that rewrites a generated file turns the gate red on a file nobody edits.
  # treefmt globs match at ANY DEPTH — `node_modules/*` is not just the top-level one.
  settings.global.excludes = [
    "*.lock"
    "flake.lock"
    "result"
    "result-*"
    "node_modules/*"
    ".next/*"
    ".nix-stack/*"
  ];
}
