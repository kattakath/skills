#!/usr/bin/env bash
# Static cases for brain-signals' own markdown: the output style, skills, agent and command.
#
# Why a test for prose: every check here is a defect that shipped silently, because Claude
# Code IGNORES what it does not recognise instead of failing (output-styles docs: "A
# misspelled field is ignored without an error").
#   - `agent: cartographer` in a plugin skill resolved to general-purpose — measured with
#     `claude -p /brain-signals:map` on 2.1.300 (task_started subagent_type general-purpose);
#     the registered name is `brain-signals:cartographer`.
#   - `permissionMode` on a plugin agent is ignored ("For security reasons, plugin subagents
#     don't support the hooks, mcpServers, or permissionMode frontmatter fields",
#     https://code.claude.com/docs/en/sub-agents).
#   - The diagram width check is copied into three files; a copy that drifts back to a bare
#     `wc -L` reads BYTES on macOS (BSD wc) and undercounts without a UTF-8 locale (GNU wc).
#   - Skill descriptions go into the system prompt: third person, <=1024 chars, no XML tags
#     (https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices).
#   - nix-config selects the style as "brain-signals:Brain Signals"; a rename applies nothing.
#
# Run:  bash plugins/brain-signals/tests/shape-cases.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 -I - "$ROOT" <<'PY'
import os, re, shutil, subprocess, sys

root = sys.argv[1]
passed = failed = 0

def check(ok, label, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"  ok    {label}")
    else:
        failed += 1
        print(f"  FAIL  {label}" + (f" ({detail})" if detail else ""))

def front(path):
    text = open(path, encoding="utf-8").read()
    m = re.match(r"---\n(.*?)\n---\n(.*)", text, re.S)
    assert m, f"{path}: no frontmatter"
    keys = {}
    for line in m.group(1).splitlines():
        km = re.match(r"([A-Za-z_-]+):\s*(.*)", line)
        if km:
            keys[km.group(1)] = km.group(2).strip().strip('"')
    return keys, m.group(2), text

rel = lambda p: os.path.relpath(p, root)
style = os.path.join(root, "output-styles", "brain-signals.md")
skills = sorted(
    os.path.join(root, "skills", d, "SKILL.md") for d in os.listdir(os.path.join(root, "skills"))
)
agents = sorted(
    os.path.join(root, "agents", f) for f in os.listdir(os.path.join(root, "agents")) if f.endswith(".md")
)
commands = sorted(
    os.path.join(root, "commands", f) for f in os.listdir(os.path.join(root, "commands")) if f.endswith(".md")
)

# https://code.claude.com/docs/en/output-styles — the four recognised fields.
STYLE_KEYS = {"name", "description", "keep-coding-instructions", "force-for-plugin"}
# https://code.claude.com/docs/en/plugins/components — what a PLUGIN agent honours.
AGENT_KEYS = {"name", "description", "model", "effort", "maxTurns", "autoCompactWindow", "tools",
              "disallowedTools", "skills", "memory", "background", "omitClaudeMd", "isolation",
              "color", "experimental"}
# https://code.claude.com/docs/en/skills — skill frontmatter (commands: same minus name/paths).
SKILL_KEYS = {"name", "description", "when_to_use", "argument-hint", "arguments",
              "disable-model-invocation", "user-invocable", "allowed-tools", "disallowed-tools",
              "model", "effort", "context", "agent", "background", "hooks", "paths", "shell",
              "metadata", "license", "compatibility"}
BUILTIN_AGENTS = {"Explore", "Plan", "general-purpose"}
PLUGIN = "brain-signals"

print("== output style ==")
k, body, text = front(style)
check(set(k) <= STYLE_KEYS, "style: only recognised frontmatter keys", sorted(set(k) - STYLE_KEYS))
check(k.get("name") == "Brain Signals", "style: name is 'Brain Signals' (nix-config selects brain-signals:Brain Signals)", k.get("name"))
check(k.get("keep-coding-instructions") == "true", "style: keep-coding-instructions true (default false drops the coding section)")
check("force-for-plugin" not in k, "style: no force-for-plugin (selection stays the user's setting)")
check("AskUserQuestion" in body, "style: asks for AskUserQuestion options (what stop-limbo warns about)")
check("https://github.com/kattakath/nix-config/blob/main/docs/answer-shape-evidence.md" in body,
      "style: evidence cited as a URL a consumer can open")

print("== agents ==")
agent_names = set()
for a in agents:
    k, body, _ = front(a)
    agent_names.add(k.get("name"))
    check(set(k) <= AGENT_KEYS, f"{rel(a)}: only keys a plugin agent honours", sorted(set(k) - AGENT_KEYS))

print("== skills and commands ==")
for s in skills + commands:
    k, body, _ = front(s)
    allowed = SKILL_KEYS - ({"name", "paths"} if s in commands else set())
    check(set(k) <= allowed, f"{rel(s)}: only recognised frontmatter keys", sorted(set(k) - allowed))
    d = k.get("description", "")
    check(0 < len(d) <= 1024, f"{rel(s)}: description 1..1024 chars", len(d))
    check(not re.search(r"<[^>]+>", d), f"{rel(s)}: description has no XML tags")
    check(not re.search(r"\b(?:I|me|my)\b", d), f"{rel(s)}: description in third person", d)
    if "agent" in k:
        ag = k["agent"]
        ok = ag in BUILTIN_AGENTS or (ag.startswith(PLUGIN + ":") and ag.split(":", 1)[1] in agent_names)
        check(ok, f"{rel(s)}: agent '{ag}' is built-in or namespaced {PLUGIN}:<own agent>")

print("== diagram width check: one recipe in every copy ==")
CANON_RENDER = "mermaid-ascii -p 0 -x 1 -y 2"
CANON_WIDTH = "LC_ALL=C.UTF-8 wc -mL"
diagram = os.path.join(root, "skills", "diagram", "SKILL.md")
cartographer = os.path.join(root, "agents", "cartographer.md")
for f in (style, diagram, cartographer):
    t = open(f, encoding="utf-8").read()
    check(CANON_RENDER in t, f"{rel(f)}: canonical render flags")
    check(CANON_WIDTH in t, f"{rel(f)}: canonical width check")
for f in [style] + skills + agents + commands:
    t = open(f, encoding="utf-8").read()
    bare = re.findall(r"\|\s*wc -L\b", t)
    check(not bare, f"{rel(f)}: no bare '| wc -L' (bytes on BSD, undercount without UTF-8)", bare)

print("== the recipe measures what it claims ==")
if shutil.which("mermaid-ascii"):
    src = 'graph TD\n  A["step one"] --> B["step two"]\n'
    art = subprocess.run(["mermaid-ascii", "-p", "0", "-x", "1", "-y", "2"], input=src,
                         capture_output=True, text=True).stdout
    want = max(len(l) for l in art.splitlines())  # every glyph here is one column wide
    env = dict(os.environ, LC_ALL="C.UTF-8")
    out = subprocess.run(["wc", "-mL"], input=art, capture_output=True, text=True, env=env).stdout
    got = int(out.split()[-1]) if out.split() else -1
    check(got == want, f"'{CANON_WIDTH}' last number = display columns ({want})", f"got {got}")
else:
    print("  skip  mermaid-ascii not on PATH; the live width case did not run")

total = passed + failed
if total < 40:
    print(f"FAIL: only {total} cases ran (floor 40)")
    failed += 1
print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
PY
