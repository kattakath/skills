#!/usr/bin/env python3
"""Compare this plugin's nixpkgs pin with nix-config's; print a GitHub warning when they differ.

The `--cache` verdict in the README holds only for the rev flake.lock pins, and the pin is
bumped by hand when nix-config's moves (README § Bumping the nixpkgs pin). This is the
watcher for that hand step. It WARNS and exits 0: a lag between nix-config's weekly bump and
the hand bump here is expected, and a darwin rerun must follow any bump anyway.

    lock-parity.py <nix-config>/flake.lock      # run from the repo root or anywhere
"""
import json
import sys
from pathlib import Path

LOCK = Path(__file__).resolve().parent.parent / "flake.lock"


def nixpkgs(path):
    lock = json.loads(Path(path).read_text())
    ref = lock["nodes"][lock["root"]]["inputs"]["nixpkgs"]
    node = lock["nodes"][ref if isinstance(ref, str) else ref[-1]]
    return node["locked"]["rev"], node.get("original", {}).get("url", "?")


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    ours, ours_url = nixpkgs(LOCK)
    theirs, theirs_url = nixpkgs(sys.argv[1])
    if ours == theirs:
        print(f"markup-lsp: nixpkgs pin matches nix-config ({ours[:12]})")
        return
    print(
        f"::warning file=plugins/markup-lsp/flake.lock::markup-lsp pins nixpkgs {ours[:12]} ({ours_url}),"
        f" nix-config pins {theirs[:12]} ({theirs_url}); bump by hand per the plugin README"
        " § Bumping the nixpkgs pin, then rerun tests/run.sh --cache on a Mac"
    )


if __name__ == "__main__":
    main()
