# CLI contract

The one contract for every command a repo ships, whether it's a flake app or a plugin `bin/`
script. It doesn't decide **whether** to write a CLI (§ When to write one does). Every rule
names its source, checked at the source on 2026-11-28.

## When to write one

- **Only for a real, recurring need,** with the evidence beside it: the backlog census, or
  the repeated hand-run it replaces. That's the YAGNI rule. Precedent: kattakath/nix-config's
  ADR-002, where extracted satellite flakes went 5 → 7 → **0** once each had to justify
  itself.
- **Fewer, more specific tools beat many small ones.** Anthropic, *Writing effective tools
  for agents*: "We recommend building a few thoughtful tools targeting specific high-impact
  workflows".
- **A binary on PATH costs no model context** until a skill or a hook advertises it. So
  advertise it only where it's the next step.

## Surface

| Rule | Source |
|---|---|
| Follow clig.dev for the surface; POSIX is the floor. `--` ends options: "The first -- argument that is not an option-argument should be accepted as a delimiter indicating the end of options." | [clig.dev](https://clig.dev); POSIX XBD 12.2, Guideline 10 |
| `--help` prints to **stdout** and exits **0**: "output brief documentation for how to invoke the program, on standard output, then exit successfully". (clig.dev says to show help, not which stream.) | GNU Coding Standards § `--help` |
| Primary output goes to stdout; "Log messages, errors, and so on should all be sent to `stderr`." | clig.dev |
| `--json` where the command returns data: "Display output as formatted JSON if `--json` is passed." | clig.dev |
| An interactive or destructive command takes `--no-input` ("don't prompt or do anything interactive") and `--dry-run`. A destructive step prompts on a TTY, or else requires `-f`/`--force`. | clig.dev |
| Honour `NO_COLOR` (set and non-empty means no colour). Follow the XDG base-directory spec for config, state and cache. | clig.dev |
| Config precedence, highest first: flags, then env, then project config, then user config, then system config. | clig.dev |

## Exit codes

- **0** success, **1** failure, **2** usage error. Bash's own convention: "All builtins return
  an exit status of 2 to indicate incorrect usage, generally invalid options or missing
  arguments." (Bash manual § Exit Status)
- **Add a code only for an important failure mode,** and list it in `--help`. clig.dev:
  "Map the non-zero exit codes to the most important failure modes."
- **Not sysexits** (64 usage, 69 unavailable, …). FreeBSD sysexits(3): "This interface has
  been deprecated and is retained only for compatibility."
- **An existing documented code that callers depend on stays** until a major version bump.
  Renumbering one silently is worse than an odd number.

## Never wire a CLI straight in as a hook

**Exit 2 means opposite things.** To a CLI it is a usage error. To a Claude Code hook it
**blocks** the action: "A hook that blocks by exiting 2 routes the same way as `"deny"`"
([hooks docs](https://code.claude.com/docs/en/hooks)). A CLI hit with a bad flag would block
a tool call by accident.
- Put a **thin adapter** between them. It runs the CLI, maps its result to the hook contract
  (exit 0 plus JSON for advice, exit 2 plus a stderr reason only for a real block), and owns
  that mapping in one place.

## Triggering from Claude Code

- **Use hooks that fit the moment:** `Notification` with matcher `permission_prompt`, and
  `Stop`, whose input carries `last_assistant_message`. Both are in the hooks docs.
- **Don't build on PreToolUse `updatedInput` rewrites.** Per the hooks docs, in auto mode
  "Claude Code can deny the changed call" when no `permissionDecision` comes with it. Only some
  hooks are exempt (a plugin's or settings' command hook on Bash, Edit, Write and a few
  others). A rewrite that works in one mode and is denied in another is not a contract.
- **Guard every call with `command -v <cli>`.** The hook or skill degrades to today's
  behaviour when the CLI isn't installed.

## Agent-facing output

From Anthropic's *Writing effective tools for agents*:
- **Errors are actionable:** "clearly communicate specific and actionable improvements". Say
  what to run or change, not only what failed.
- **Output is concise by default,** detailed on request: "allowing your agent to control
  whether tools return “concise” or “detailed” responses". A `--json` mode or a `--verbose`
  flag is that switch.

## Packaging (flake apps)

- **`writeShellApplication` with `inheritPath = false`.** The default is `true`, and then
  `PATH` is set to `runtimeInputs` **followed by `$PATH`**. An undeclared command quietly
  falls through to whatever the host has. Measured in nixpkgs
  `pkgs/build-support/trivial-builders/default.nix`: `inheritPath ? true` and
  `lib.optionals inheritPath [ "$PATH" ]`.
- **List the basic tools in `runtimeInputs`** (`coreutils`, `gnused`, `gnugrep`, …). macOS's
  `/bin/bash` is 3.2 and its BSD `sed`/`grep` differ from GNU's, so a script that leans on
  the host's tools behaves differently there.
- **Set `meta.mainProgram` and `meta.description`.** Expose each command through the flake
  `apps` schema: "`type` (required): Must be set to `app`", "`program` (required): The full
  path of the executable to run. It must reside in the Nix store.", and optional
  `meta.description` (Nix manual, `nix run`).
- **Known gap: `assets/flake-template.nix` predates this rule.** Its `mk` still inherits
  `PATH`, and its prelude uses host tools (`git`, `cksum`, `cut`). Switching it needs those
  in `runtimeInputs` and a build of a generated project, so it's a follow-up, not a blind
  flip.
- **A plugin `bin/` script can't be a Nix build.** It ships as plain source to every install.
  There, write bash 3.2 with only POSIX tools, and lint it in CI.

## Tests

- **With `--version`:** `versionCheckHook` fails the build when the version string is missing
  from `--version`/`--help` output; `testers.testVersion` is "a softer option" in
  `passthru.tests`. Both are in the nixpkgs manual.
- **Otherwise,** a stub-based test (or `bats`, which nixpkgs packages) runs as a flake check
  or a CI step. Stub every external command the CLI drives; record its argv, then assert on it.
- **Include one negative control:** a case, or a recorded mutation, that proves the test can
  fail.

## Optional: one spec for help, man pages and completions

`usage` (jdx) reads "a portable KDL specification" and can "Generate shell completions,
reference documentation, and client libraries from that definition", plus "Markdown pages
and Unix man pages" ([usage.jdx.dev](https://usage.jdx.dev)). Worth it once a CLI has
subcommands and completions matter. Below that, a hand-written `--help` is enough.
