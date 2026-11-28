#!/usr/bin/env python3
"""Compare this plugin's nixpkgs pin with nix-config's.

The `--cache` verdict in the README holds only for the rev flake.lock pins, and the pin is
bumped by hand when nix-config's moves (README § Bumping the nixpkgs pin). This is the
check behind the watcher for that hand step: .github/workflows/markup-lsp-pin.yml runs it
daily and keeps ONE open issue while the pins differ.

Exit codes, so a lag and a broken check can never look alike:
    0  the pins match
    3  the pins differ (a real lag); the message says what to do
    anything else  the check itself failed (missing file, changed lock shape)

    lock-parity.py <nix-config>/flake.lock [<our flake.lock>]
"""
import json
import sys
from pathlib import Path

LAG = 3
LOCK = Path(__file__).resolve().parent.parent / "flake.lock"


def nixpkgs(path):
    lock = json.loads(Path(path).read_text())
    ref = lock["nodes"][lock["root"]]["inputs"]["nixpkgs"]
    node = lock["nodes"][ref if isinstance(ref, str) else ref[-1]]
    return node["locked"]["rev"], node.get("original", {}).get("url", "?")


def main():
    if len(sys.argv) not in (2, 3):
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    ours, ours_url = nixpkgs(sys.argv[2] if len(sys.argv) == 3 else LOCK)
    theirs, theirs_url = nixpkgs(sys.argv[1])
    if ours == theirs:
        print(f"markup-lsp: nixpkgs pin matches nix-config ({ours[:12]})")
        return
    print(
        f"markup-lsp pins nixpkgs {ours[:12]} ({ours_url}), nix-config pins {theirs[:12]}"
        f" ({theirs_url}). Bump by hand per plugins/markup-lsp/README.md § Bumping the nixpkgs"
        " pin, then rerun tests/run.sh --cache on a Mac."
    )
    sys.exit(LAG)


if __name__ == "__main__":
    main()
