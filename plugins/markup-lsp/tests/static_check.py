#!/usr/bin/env python3
"""Static checks on .lsp.json that need no Nix.

usage: static_check.py <repo-root>

- every server has a non-empty `command` and `extensionToLanguage`;
- every extension starts with a dot;
- no extension is claimed twice, either inside this plugin or by another plugin in this
  marketplace (an LSP plugin's `.lsp.json` or `plugin.json` `lspServers`). Two plugins
  claiming `.json` would both start a server for the same file.
"""

import json
import pathlib
import sys

ME = "markup-lsp"


def servers(plugin: pathlib.Path) -> dict:
    manifest = json.loads((plugin / ".claude-plugin" / "plugin.json").read_text())
    lsp = manifest.get("lspServers")
    if lsp is None and (plugin / ".lsp.json").exists():
        lsp = json.loads((plugin / ".lsp.json").read_text())
    return lsp if isinstance(lsp, dict) else {}


def main() -> int:
    root = pathlib.Path(sys.argv[1])
    errors = []
    owner: dict[str, str] = {}
    mine = servers(root / "plugins" / ME)
    if not mine:
        errors.append(f"{ME}: no LSP servers found")
    for plugin in sorted((root / "plugins").iterdir()):
        if not (plugin / ".claude-plugin" / "plugin.json").exists():
            continue
        for name, spec in servers(plugin).items():
            where = f"{plugin.name}:{name}"
            if plugin.name == ME:
                if not spec.get("command"):
                    errors.append(f"{where}: empty command")
                if not spec.get("extensionToLanguage"):
                    errors.append(f"{where}: empty extensionToLanguage")
            for ext in spec.get("extensionToLanguage", {}):
                if not ext.startswith("."):
                    errors.append(f"{where}: extension {ext!r} does not start with '.'")
                if ext in owner and ME in (plugin.name, owner[ext].split(":")[0]):
                    errors.append(f"{ext} claimed by both {owner[ext]} and {where}")
                owner.setdefault(ext, where)
    for e in errors:
        print(f"FAIL {e}")
    n = sum(len(s.get("extensionToLanguage", {})) for s in mine.values())
    print(f"{len(mine)} servers, {n} extensions, {len(errors)} problems")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
