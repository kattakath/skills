# Worked examples — what a real run found

Three findings from the run this plugin was extracted from: one repo
([`kattakath/nix-config`](https://github.com/kattakath/nix-config)), one afternoon,
**2026-09-15**. All three were **fixed the next day** — the fix commits are named below, which
is the point: each one is a defect whose *class* recurs, and none of them was visible to any
gate the repo already ran (`nix flake check`, `ast-grep`, `statix`, `deadnix`, two CI legs).

Read these before auditing. Each is written as **symptom → why no gate saw it → the general
pattern → how to hunt it**, because the pattern is the reusable part.

---

## 1. Silent success — `exit 0` inside a concatenated activation script

**Lane:** validation. **Severity:** SEV-1.

### Symptom

`darwin-rebuild switch` printed no error and exited 0. The system was **half applied**: the
system profile advanced, but `/run/current-system` — which `PATH` and the current-system GC root
resolve through — still pointed at the *previous* generation.

### Mechanism

An upstream nix-darwin module (`modules/programs/mas.nix:58`) handles a signed-out Mac App Store
gracefully:

```bash
if echo "${listOutput}" | grep -qi "not signed in"; then
  echo >&2 "login required; skipping App Store installs/updates/cleanup"
  exit 0
fi
```

Perfectly reasonable — **inside a subshell or a function**. It is neither. nix-darwin builds
**one** bash script by string-interpolating every activation slot in sequence
(`modules/system/activation-scripts.nix:83-152`; the `mas` slot is line 137, between `nvram` and
`homebrew`). So that `exit 0` is a **top-level exit of the whole activate script**.

Measured on the live built script: the `exit 0` landed at **line 1818 of 2040**. Everything
after it never ran — the Homebrew bundle, both home-manager profiles, and the closing
`ln -sfn … /run/current-system` at line 2034.

**Nothing printed "failed", because nothing failed.** The script did exactly what it was told.

### Why no gate saw it

Every gate in that repo is an **evaluation** gate. The defect is in the *concatenated runtime
text* of a script that only exists after a successful build, in an upstream dependency, and only
manifests when a runtime precondition (signed-out App Store) is false. Eval is green; the build
is green; the switch is green.

### The general pattern

> **A snippet authored as if it owns the process, composed into a script it does not own.**

`exit`, `return` at top level, `trap … EXIT`, `set -e`/`set +e` toggles, `cd` without a subshell
— all change meaning when concatenated. The composition is usually invisible from the snippet's
own file.

### How to hunt it

```bash
# every `exit` in anything that becomes an activation/setup snippet
grep -rn 'exit 0\|^\s*exit\b\|trap .*EXIT\|set +e' --include='*.nix' --include='*.sh' .
# and in the PINNED inputs, which is where this one lived
grep -rn 'exit 0' /nix/store/*-source/modules/ 2>/dev/null
# then read the composer: which file concatenates the slots, and in what order?
grep -rn 'activationScripts' --include='*.nix' . | head
```

Then read the **built** artifact, not the source: `/run/current-system/activate`, the rendered
unit, the generated wrapper. Cite it by grep anchor, never by line number (calibration C3).

### Related, opposite sign

The same repo, same week: a never-logged-in account's launchd agent failed `Bootstrap failed:
125`, and `set -e` at the top of the same concatenated script killed it ~80 lines short of the
same `ln -sfn`. Same blast radius, loud instead of silent. **A composed script has exactly two
ways to strand you, and both live in the composer, not the snippet.**

---

## 2. A guardrail that matched nothing

**Lane:** dead surface. **Severity:** SEV-1. **Fixed:** `d39fc80`.

### Symptom

A `permissions.deny` rule existed specifically to block imperative MCP-server installation — the
exact thing the repo's own ADR forbids. It had **never fired once**, because the tool name it
blocked does not exist.

```jsonc
// the rule, in two spellings, both dead
"mcp__plugin_claude-code-home-manager_mcpfinder__add_mcp_server_config"   // stale long prefix
"mcp__mcpfinder__add_mcp_server_config"                                  // bare, no-plugin form
```

The live tool name is `mcp__plugin_hm_mcpfinder__add_mcp_server_config`. The plugin prefix had
been shortened; both rules kept the old shapes. **Twelve** `allow` rules in the same repo had
the same rot (`mcp__context7__*`, `mcp__memory__*`, … and one doubly wrong:
`mcp__sequentialthinking__*` where the server is hyphenated `sequential-thinking`).

### Why no gate saw it

**Nothing anywhere reports a rule that never matches.** A permission list, a hook pattern, a CI
path filter and a lint ignore are all *allowed* to match nothing — that is a normal state, not an
error. The config is syntactically valid, the file parses, the session starts. A dead rule and a
rule that has simply not been triggered yet are indistinguishable from the inside.

The tell was already in the tree and no tool could correlate it: **one** server had been fixed
(`mcp__plugin_hm_context7__*` in a Nix module) while twelve had not, and the same file carried
*both* spellings for one server — seven dead lines directly above seven live ones.

### The general pattern

> **A pattern is only a guardrail if something it is meant to match still exists.**
> A rename on the *matched* side silently disarms every rule on the *matching* side.

This generalises well past permissions: `.gitignore` entries for moved directories, CI
`paths:` filters, `CODEOWNERS` globs, lint `exclude` lists, `grep`-based hooks, log alert
patterns, firewall rules naming a retired interface.

### How to hunt it

For every pattern-shaped rule, enumerate **the real namespace it is meant to match** and check
for at least one hit:

```bash
# permission / hook rules vs the tool names a live session actually sees
grep -rn 'mcp__\|Bash(\|Write(\|Edit(' .claude/settings.json modules/ | sed 's/.*"\(.*\)".*/\1/'
# CI path filters vs the tree
yq '.on.push.paths[]' .github/workflows/*.yml | while read -r p; do
  compgen -G "$p" >/dev/null || echo "MATCHES NOTHING: $p"; done
# lint excludes vs the tree
grep -rn 'exclude\|ignore' treefmt.* .*.toml 2>/dev/null
```

**A rule with zero possible matches is a SEV-1 when someone believes it is protecting them.**
Rank it by what the rule was *for*, not by its size.

### Design note, worth repeating

The fix deliberately added **no** automated check. Half the rule (the server name) is assertable
from the repo's own config; the other half (the plugin prefix) is an artifact of a system the
repo cannot see. A check over the assertable half would have gated the half that did not break —
which is the [gate-must-move-with-the-content](https://github.com/kattakath/nix-config/blob/main/docs/agent-resource-externalization.md)
failure in miniature. **Sometimes the honest output is a dated comment, not a gate.**

---

## 3. A template shipping the author's personal state

**Lane:** architecture. **Severity:** SEV-1. **Fixed:** `c4a522a`.

### Symptom

The repo published a starter template (`nix flake init -t`) so strangers could consume its
composition library. Following the template's own instructions would have created **the author's
second admin account** on the stranger's machine — plus two of his self-hosted CI runner lanes
and 34 of his Homebrew casks.

### Mechanism

The composition API took a host **name** and interpolated it into a path indexing the
**engine's own** directory:

```nix
# modules/parts/compose.nix — mkDarwin
hostname,
# …
../../hosts/${hostname}.nix     # ← resolves inside the ENGINE, not the consumer's repo
```

and the template called it with the author's real host:

```nix
# templates/default/flake.nix
darwinConfigurations.macos = nix-config.lib.mkDarwin {
  hostname = "macos";           # ← the author's 929-line personal host profile
};
```

Measured by evaluating the template's call as an unrelated caller:

```
users.users ? <author's second account>  -> true    (an admin account)
users.knownUsers                          -> [ _github-runner, <account> ]
homebrew.casks                            -> 34
```

`users.knownUsers` is the create/**delete** switch, so this was destructive in **both**
directions — it creates accounts a stranger did not ask for, and removing a name later deletes
one.

### Why no gate saw it

The template **evaluates perfectly**. It is a correct flake producing a correct
`darwinConfiguration`. Every gate asks *does it build?* — none asks *does it build the right
person's machine?* And the seam is a **string interpolated into a path**, so there is no import
edge for a structural linter to follow: the dependency exists only after the string is
substituted.

### The general pattern

> **A parameter that is a NAME resolved in the provider's namespace is not a parameter —
> it is a default the consumer cannot see.**

The consumer thinks they are choosing; they are indexing someone else's directory. The same
shape: a "profile" string looked up in the library's own profiles dir, an "env" key read from the
provider's config, a `preset = "default"` that dereferences the author's presets, a base Docker
image tag pointing at an internal registry.

The fix is the same every time: **pass the thing, not its name.** The API now takes a
`hostModule` (with the old string form as the *default*, so the author's own call is byte
identical — verified: the toplevel `drvPath` did not change), and the template points at a new
36-line `generic-darwin.nix` with an explicit `# Do NOT change this to "macos"`.

### How to hunt it

```bash
# names interpolated into paths that index the provider's own tree
grep -rn '\.\./.*\${' --include='*.nix' .
grep -rnE '(profile|preset|env|host|flavou?r|variant)\s*[=:]\s*"' --include='*.nix' .
```

Then, for every published artifact — template, example, starter, quickstart, scaffold — **read
it as a stranger and ask what it materialises.** Where the tooling allows, evaluate it and dump
the user/account/package surface it would create. A template is code that runs on someone else's
machine; audit it as such.

---

## What these three have in common

| | Silent success | Dead guardrail | Template leak |
|---|---|---|---|
| Does it build? | ✅ | ✅ | ✅ |
| Does it evaluate? | ✅ | ✅ | ✅ |
| Does CI pass? | ✅ | ✅ | ✅ |
| Is anything reported? | **no** | **no** | **no** |
| Would a human notice? | only much later, as a weird symptom | **never** | only after damage, on someone else's machine |

**Every finding worth this audit's cost has a green build.** If the build is red, the repo
already told you. Calibration rule C7 exists because of exactly this: a lane that spends its
budget re-deriving what the gates already say has spent it on nothing.
