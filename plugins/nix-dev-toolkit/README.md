# nix-dev-toolkit

Make a repo **self-contained with Nix** for development, deployment and maintenance: one
`flake.nix` carrying the dev shell, a catalogue of every environment variable the project reads,
a project-local service stack, and named `nix run .#<verb>` commands for the operations people
actually perform.

## What it ships

| Component | What it does |
|---|---|
| `assets/flake-template.nix` | A working, genericised flake — dev shell, env catalogue, Postgres+pgvector stack, lifecycle apps — with `# ADAPT:` markers on everything that must change |
| `assets/envrc-template` | The committed `.envrc`: load **order** only, no values, so it is safe in git |
| `references/env-catalogue.md` | Rendering `env-doctor` / `env-template` from the catalogue, and the secret-handling rules |
| `references/local-stack.md` | Postgres+pgvector lifecycle, socket URL construction, job runners, self-hosted GitHub runner provisioning, name guards |
| `references/gotchas.md` | Each trap with the *symptom* it produces, so a failure can be matched back to its cause |

## The principle

**Prefer adding a command to the flake over documenting a manual procedure in a README.** Every
command is a `writeShellApplication`, so `shellcheck` runs at build time: a broken command fails
`nix build`, not somebody's afternoon. A README is never checked.

The env catalogue applies the same idea to configuration. One attrset names every variable with
how badly it is needed and whether it is secret; `env-doctor` and `env-template` are *generated*
from it, so documentation cannot drift from reality. Secrets are reported by **presence only** —
never echoed, logged or interpolated.

## The traps worth reading before you write any of it

- **Never realpath a `withPackages` binary.** `postgresql_16.withPackages (p: [ p.pgvector ])`
  builds an lndir tree whose `share/postgresql` is the union but whose `bin/*` symlink *back* to
  the plain package. Resolving the real path silently loses pgvector — surfacing much later as
  `extension "vector" is not available`.
- **A socket connection URL must carry the port.** The socket file is `<dir>/.s.PGSQL.<port>`, so
  omitting it sends clients to the default and fails to connect.
- **A unix socket path has a ~104-byte limit on macOS.** A deep checkout blows it; fall back to a
  short `/tmp` path keyed by a hash of the project path.
- **`.gitignore`'s usual `.env*` line also ignores `.envrc`.** Add `!.envrc`, then ignore
  `.envrc.local` and `/.direnv/`.
- **Detect direnv with `DIRENV_IN_ENVRC`, not `DIRENV_DIR` alone** — while `.envrc` is still
  evaluating only the former is set, so the naive check prints "direnv is not active" during the
  very load it is advising on.

Services are project-local and **socket-only** (`listen_addresses=''`), with a name guard on every
destructive command: other real databases live on the same machine.
