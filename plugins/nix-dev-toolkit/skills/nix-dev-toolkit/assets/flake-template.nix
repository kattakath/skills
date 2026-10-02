# A self-sufficient dev / deploy / maintenance toolkit.
#
#   nix develop            → shell with every CLI this project needs
#   nix fmt                → treefmt over the whole tree (per file type, not per formatter)
#   nix flake check        → formatting + toolchain-complete + project-gate, and shellcheck on
#                            every command below
#   nix run .#toolkit      → list every command
#   nix run .#env-doctor   → which catalogued env vars are set (NAMES only, never values)
#   nix run .#stack-up     → project-local Postgres+pgvector (socket-only) + job runner
#
# ADAPT markers show what must change per project. Everything else is portable. ONE of them —
# `projectGate` — makes `nix flake check` FAIL until it is edited. That is deliberate; its own
# comment says why, and how to record "this repo has no such command" without lying about it.
#
# SHIPS WITH A SIBLING: `treefmt.nix` beside this file (the skill's
# `assets/treefmt-template.nix`). Both `formatter` and the `formatting` check evaluate it, so
# dropping this flake in on its own leaves a dangling `./treefmt.nix` reference.
#
# Two rules encoded here that are easy to "simplify" into a broken state:
#   1. Postgres is invoked through the `withPackages` UNION prefix (`${pg}/bin/...`) and never
#      realpath'd — realpath lands on the plain package and silently loses pgvector.
#   2. The socket URL carries the PORT, because a socket's filename is `<dir>/.s.PGSQL.<port>`.
{
  description = "project toolkit"; # ADAPT

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    # The one non-nixpkgs input, and it is here because it DELETES hand-written code rather than
    # adding a framework: `formatter` and the `formatting` check are both its output. Its only
    # dependency is nixpkgs, so the `follows` collapses it to a SINGLE extra lock node.
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      treefmt-nix,
    }:
    let
      project = "app"; # ADAPT: used for state dirs and the default database name

      # Load the project's own `.env` files into the environment WITHOUT overriding anything the
      # caller already exported. Shared verbatim by the CLI apps' prelude and by the dev shell.
      #
      # WHY, given `.envrc` already does this: direnv covers an interactive `cd` into the repo,
      # but `nix run .#deploy-prod` from a script, a CI step, or a shell where direnv is not
      # hooked would otherwise see none of it. Loading here means a command behaves the same
      # either way, and it is idempotent — anything direnv already exported is left untouched.
      #
      # PRECEDENCE, and why the file order looks backwards: each variable is set only if it is
      # currently unset, so the FIRST file to mention a name wins. Reading highest-precedence
      # first therefore yields ambient env > .env.development.local > .env.local > .env, which
      # is Next.js's own order — the same one `.envrc` produces via direnv's opposite
      # last-wins semantics. Values are never echoed; this is secret material.
      dotenvLoader = ''
        _load_dotenv() {
          [ -f "$1" ] || return 0
          while IFS= read -r _line || [ -n "$_line" ]; do
            # The empty pattern is written with DOUBLE quotes on purpose: a pair of single
            # quotes terminates a Nix indented string, so the obvious spelling would end this
            # block mid-function. (Writing that fact out plainly, for the same reason.)
            case "$_line" in "" | '#'*) continue ;; esac
            _line="''${_line#export }"
            _key="''${_line%%=*}"
            # Skip anything that is not a plain NAME= assignment (blank keys, `foo bar`, etc.).
            case "$_key" in "" | *[!A-Za-z0-9_]*) continue ;; esac
            _val="''${_line#*=}"
            # Strip one layer of surrounding quotes, the only quoting dotenv files really use.
            case "$_val" in
              \"*\") _val="''${_val#\"}"; _val="''${_val%\"}" ;;
              \'*\') _val="''${_val#\'}"; _val="''${_val%\'}" ;;
            esac
            # Indirect expansion: only set the name if the caller has not already exported it.
            [ -n "''${!_key:-}" ] || export "$_key=$_val"
          done < "$1"
          unset _line _key _val
        }
        _load_project_dotenv() {
          _load_dotenv "$1/.env.development.local"
          _load_dotenv "$1/.env.local"
          _load_dotenv "$1/.env"
        }
      '';

      # `x86_64-darwin` is DELIBERATELY ABSENT, and re-adding it turns `nix flake check
      # --all-systems` red before you have written a line: nixpkgs-unstable now THROWS on that
      # platform rather than evaluating, so `forAll` dies the moment it touches
      # `legacyPackages.x86_64-darwin`. Measured 2026-10-02 against nixpkgs-unstable; upstream
      # directs x86_64 Macs to the `nixpkgs-26.05-darwin` branch instead.
      #   https://nixos.org/manual/nixpkgs/unstable/release-notes#x86_64-darwin-26.11
      # ADAPT: trim this further to the platforms the project is actually developed on — a
      # system listed here is a system every check must be green on.
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      # Hand-rolled fold ON PURPOSE, and NOT the ADR-002 debt that a `forAllSystems` in
      # nix-config's own engine would be: this is a starter template handed to unrelated
      # projects, and flake-parts would add an input to every one of them. Do not "migrate" it.
      #
      # NEAR-single-input is the feature, not zero-input purity — the earlier "single-input"
      # claim here outlived the facts. `treefmt-nix` earns the exception on a different test:
      # it REMOVES code (the formatter and the `formatting` check are both its output) and costs
      # one lock node. flake-parts would buy nothing comparable, so the bar stays high.
      forAll = f: nixpkgs.lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});
      inherit (nixpkgs) lib;

      # ONE treefmt evaluation per system, reused by `formatter` and by the `formatting` check,
      # so `nix fmt` and CI can never run a different tool set. `./treefmt.nix` is the sibling
      # file named in the header — it must exist beside this flake.
      treefmtEval = forAll (_: pkgs: treefmt-nix.lib.evalModule pkgs ./treefmt.nix);

      # ── Env catalogue: the single source of truth. ────────────────────────────────────────────
      # need   : required | optional | ci | local
      # secret : true → tooling reports PRESENCE ONLY, never the value
      # used   : true when the application source reads it (omit for tooling-only vars)
      # ADAPT: harvest with
      #   grep -rhoE 'process\.env\.[A-Z0-9_]+' src/ | sed 's/process\.env\.//' | sort -u
      envCatalogue = {
        DATABASE_URL = {
          need = "required";
          secret = true;
          used = true;
          note = "Runtime connection string.";
        };
        NODE_ENV = {
          need = "optional";
          secret = false;
          used = true;
        };
        GH_TOKEN = {
          need = "optional";
          secret = true;
          note = "gh CLI; also used by runner-provision.";
        };
        CLOUDFLARE_API_TOKEN = {
          need = "optional";
          secret = true;
          note = "wrangler / DNS. Tooling-consumed, not read by the app.";
        };
        PG_PORT = {
          need = "local";
          secret = false;
          note = "Local cluster port. Default 5433.";
        };
      };

      envNames = lib.attrNames envCatalogue;
      envTsv = lib.concatMapStringsSep "\n" (
        n:
        let
          e = envCatalogue.${n};
        in
        lib.concatStringsSep "\t" [
          n
          (e.need or "optional")
          (if (e.secret or false) then "secret" else "plain")
          (e.note or "")
        ]
      ) envNames;

      # ── What the dev shell promises. ──────────────────────────────────────────────────────────
      # ONE list: `devShells` AND the `toolchain-complete` check both read it, so they can never
      # disagree about what "the dev shell" contains. Inlining it in `devShells` (where it used to
      # live) would make the check assert against a second copy, i.e. against nothing.
      #
      # ADAPT: the CLIs this project actually shells out to. Check availability first with
      # `nix search nixpkgs <name>`; some (e.g. vercel, inngest-cli) are not packaged and should
      # stay on `npx --yes` with the version pinned in one place.
      devPackagesFor =
        pkgs:
        [
          # The UNION prefix package, same as the commands use. A plain `postgresql_16` here would
          # put a psql on PATH that cannot see pgvector — see header rule 1.
          (pkgs.postgresql_16.withPackages (p: [ p.pgvector ]))
        ]
        ++ (with pkgs; [
          nodejs_22
          gh
          git
          jq
          yq-go
          curl
          openssl
        ]);

      # Binaries this project's scripts / CI / hooks shell out to and that MUST resolve inside the
      # dev shell. ADAPT. Writing them down is the whole of what turns `toolchain-complete` from a
      # tautology into a gate, because a PACKAGE name is not a BINARY name: `pkgs.yq-go` ships
      # `yq`, `pkgs.nodejs_22` ships `node` AND `npx`, postgresql ships `psql`. That map is
      # exactly what a reader editing the list above gets wrong, and nothing else here notices.
      requiredBins = [
        "node"
        "npx"
        "psql"
        "gh"
        "git"
        "jq"
        "yq"
        "curl"
        "openssl"
      ];

      # ── The project's own test/build command. ─────────────────────────────────────────────────
      # ADAPT — THIS LINE MUST BE EDITED. `nix flake check` FAILS until it is, by design:
      #   { command = "npm test"; packages = p: [ p.nodejs_22 ]; }  → the real gate
      #   { absent  = "<why this repo has none>"; }                 → recorded absent, with reason
      #
      # Required-with-a-name is the proven shape: Terraform's `variable` with no `default` fails
      # the plan and NAMES the variable; NixOS' `mkOption` with no `default` fails eval and names
      # the option. Optional-with-a-comment is the shape that rots: this template's `checks =
      # packages` line sat unexamined until someone finally measured it. It turned out CORRECT —
      # but nothing could have told you either way, because a line that never goes red never
      # gets read. A knob that fails until it is answered does not have that failure mode.
      #
      # `absent` is for a repo with NO such command AT ALL. It is NOT the escape hatch for a
      # command that needs the network: there, VENDOR the dependencies (`buildNpmPackage` with a
      # pinned `npmDepsHash`, or the ecosystem's equivalent) so the gate genuinely runs offline.
      # Reading `absent` as "my tests need npm install" lets the escape swallow the standard,
      # which is the one misreading that makes this knob worthless.
      #
      # AND DO NOT TRUST A GREEN GATE ON A MAC. `sandbox` is `false` by DEFAULT on darwin —
      # nixpkgs' own default, not a local misconfiguration — so a build there has FULL NETWORK
      # ACCESS. Measured 2026-10-02, same derivation shape both ways:
      #   sandbox = false (darwin default) -> curl http://registry.npmjs.org/ => http_code=301
      #   --option sandbox true            -> curl: (6) Could not resolve host
      # Linux defaults the other way, so a network-dependent gate is green on the author's Mac
      # and red in CI. Prove it offline before believing it:
      #   nix build --option sandbox true .#checks.<system>.project-gate            # fresh drv
      #   nix build --rebuild --option sandbox true .#checks.<system>.project-gate  # built drv
      # BOTH forms exist because each prevents the other's failure. Omit `--rebuild` on an
      # already-built derivation and Nix returns the cached path: a FALSE GREEN. Pass it on one
      # never built and Nix refuses — "some outputs are not valid, so checking is not possible"
      # — a FALSE RED, and the likely one, since you reach for this right after fixing
      # something, which changes the hash. Measured 2026-10-02, both directions.
      projectGate = "unwired";
    in
    {
      # treefmt's own wrapper, NOT a bare `pkgs.nixfmt-rfc-style`. `nix fmt` hands the formatter
      # the WHOLE tree, so a bare nixfmt dies `unexpected end of input` on the first `README.md`
      # — measured, and it meant `nix fmt` was broken in every repo this template produced.
      # treefmt dispatches per file type, which is the whole job. Config: ./treefmt.nix.
      formatter = forAll (system: _: treefmtEval.${system}.config.build.wrapper);

      packages = forAll (
        system: pkgs:
        let
          # The UNION prefix. Never realpath a binary out of this — see the header.
          pg = pkgs.postgresql_16.withPackages (p: [ p.pgvector ]);
          node = pkgs.nodejs_22;
          envTsvFile = pkgs.writeText "${project}-env-catalogue.tsv" envTsv;

          # `export`, not plain assignment: commands share this prelude but use only part of it,
          # and an unexported variable would be flagged unused by shellcheck.
          prelude = dotenvLoader + ''
            export PRJ="''${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
            # The project's own .env files, for the case direnv does not cover (a script, CI, a
            # shell with no direnv hook). Never overrides what the caller already exported.
            _load_project_dotenv "$PRJ"
            export STACK="''${PROJECT_STACK_DIR:-$PRJ/.nix-stack}"
            export PGDATA_DIR="$STACK/pg/data"
            export PGPORT_="''${PG_PORT:-5433}"
            export PGUSER_="postgres"
            export PGDB_="''${PG_DB:-${project}_dev}"

            # ~104-byte cap on a unix socket's full name (macOS), and the name embeds the port.
            # A deep checkout blows it, so fall back to a short /tmp path keyed by the project.
            export SOCK="$STACK/pg/sock"
            if [ ''${#SOCK} -gt 60 ]; then
              SOCK="/tmp/pgdev-$(printf '%s' "$PRJ" | cksum | cut -d' ' -f1)"
            fi
          '';

          mk =
            {
              name,
              deps ? [ ],
              text,
            }:
            pkgs.writeShellApplication {
              inherit name;
              runtimeInputs = deps;
              text = prelude + text;
            };
        in
        {
          pg-init = mk {
            name = "pg-init";
            text = ''
              [ -s "$PGDATA_DIR/PG_VERSION" ] && { echo "[pg] already initialised"; exit 0; }
              mkdir -p "$PGDATA_DIR" "$SOCK"
              chmod 700 "$PGDATA_DIR" "$SOCK"
              ${pg}/bin/initdb -D "$PGDATA_DIR" -U "$PGUSER_" \
                --auth=trust --encoding=UTF8 --no-locale --no-sync
              echo "[pg] initialised at $PGDATA_DIR"
            '';
          };

          pg-start = mk {
            name = "pg-start";
            text = ''
              [ -s "$PGDATA_DIR/PG_VERSION" ] || { echo "run pg-init first" >&2; exit 1; }
              if ${pg}/bin/pg_ctl -D "$PGDATA_DIR" status >/dev/null 2>&1; then
                echo "[pg] already running on $SOCK:$PGPORT_"; exit 0
              fi
              mkdir -p "$SOCK"; chmod 700 "$SOCK"
              # listen_addresses is set EMPTY below → no TCP at all, so no port can clash.
              # Three quotes, not two: two would close this Nix indented string. Even a comment
              # mentioning the bare two-quote form ends the string — this file hit that once.
              ${pg}/bin/pg_ctl -D "$PGDATA_DIR" -w -l "$STACK/pg/postgres.log" \
                -o "-p $PGPORT_ -k $SOCK -c listen_addresses=''' -c fsync=off" start
              ${pg}/bin/psql -h "$SOCK" -p "$PGPORT_" -U "$PGUSER_" -d postgres -Atqc \
                "SELECT 1 FROM pg_database WHERE datname='$PGDB_'" | grep -q 1 \
                || ${pg}/bin/psql -h "$SOCK" -p "$PGPORT_" -U "$PGUSER_" -d postgres -Atqc \
                     "CREATE DATABASE \"$PGDB_\""
              ${pg}/bin/psql -h "$SOCK" -p "$PGPORT_" -U "$PGUSER_" -d "$PGDB_" -Atqc \
                "CREATE EXTENSION IF NOT EXISTS vector" >/dev/null
              echo "[pg] up — socket $SOCK, port $PGPORT_, db $PGDB_, pgvector ready"
            '';
          };

          pg-stop = mk {
            name = "pg-stop";
            text = ''
              ${pg}/bin/pg_ctl -D "$PGDATA_DIR" -m fast -w stop 2>/dev/null || true
              echo "[pg] stopped"
            '';
          };

          pg-destroy = mk {
            name = "pg-destroy";
            text = ''
              # Deletes only this project's own cluster directory. It takes no database NAME, so it
              # can never be pointed at a neighbouring database on a shared server.
              ${pg}/bin/pg_ctl -D "$PGDATA_DIR" -m immediate -w stop 2>/dev/null || true
              rm -rf "$STACK/pg"
              echo "[pg] destroyed $STACK/pg"
            '';
          };

          pg-url = mk {
            name = "pg-url";
            deps = [ pkgs.python3 ];
            text = ''
              # Percent-encode the socket dir (it contains /), and CARRY THE PORT: a socket's
              # filename is <dir>/.s.PGSQL.<port>, so omitting it sends clients to the default.
              enc=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$SOCK")
              echo "postgresql://$PGUSER_@localhost:$PGPORT_/$PGDB_?host=$enc"
            '';
          };

          pg-status = mk {
            name = "pg-status";
            text = ''
              if ${pg}/bin/pg_ctl -D "$PGDATA_DIR" status >/dev/null 2>&1; then
                echo "[pg] running — $SOCK:$PGPORT_"
                echo "[pg] vector: $(${pg}/bin/psql -h "$SOCK" -p "$PGPORT_" -U "$PGUSER_" -d "$PGDB_" \
                  -Atqc "SELECT extversion FROM pg_extension WHERE extname='vector'" 2>/dev/null \
                  || echo 'NOT INSTALLED')"
              else
                echo "[pg] stopped"
              fi
            '';
          };

          pg-psql = mk {
            name = "pg-psql";
            text = ''exec ${pg}/bin/psql -h "$SOCK" -p "$PGPORT_" -U "$PGUSER_" -d "$PGDB_" "$@"'';
          };

          env-doctor = mk {
            name = "env-doctor";
            text = ''
              # Reports PRESENCE ONLY. Never prints a value. Note this sees the ambient
              # environment — it does not load .env files.
              miss=0; total=0
              printf '%-34s %-9s %-8s %s\n' VARIABLE NEED KIND STATUS
              while IFS=$'\t' read -r n need kind _note; do
                [ -z "$n" ] && continue
                total=$((total+1))
                if [ -n "''${!n:-}" ]; then st="set"; else
                  st="MISSING"; [ "$need" = required ] && miss=$((miss+1))
                fi
                printf '%-34s %-9s %-8s %s\n' "$n" "$need" "$kind" "$st"
              done < ${envTsvFile}
              echo
              if [ "$miss" -gt 0 ]; then echo "$miss required variable(s) missing."; exit 1; fi
              echo "all $total variables present."
            '';
          };

          env-template = mk {
            name = "env-template";
            text = ''
              out="''${1:-.env.example}"
              [ -e "$out" ] && { echo "refusing to overwrite $out" >&2; exit 1; }
              {
                echo "# Generated by 'nix run .#env-template'. Values are intentionally BLANK."
                echo "# Never commit a real secret."
                echo
                while IFS=$'\t' read -r n need kind note; do
                  [ -z "$n" ] && continue
                  [ -n "$note" ] && echo "# $note"
                  echo "# need=$need kind=$kind"
                  echo "$n="
                  echo
                done < ${envTsvFile}
              } > "$out"
              echo "wrote $out"
            '';
          };

          stack-up = mk {
            name = "stack-up";
            deps = [ node ];
            text = ''
              ${self.packages.${system}.pg-init}/bin/pg-init
              ${self.packages.${system}.pg-start}/bin/pg-start
              # ADAPT: start the project's own background services here.
              echo "[stack] up — DATABASE_URL=$(${self.packages.${system}.pg-url}/bin/pg-url)"
            '';
          };

          stack-down = mk {
            name = "stack-down";
            text = ''
              ${self.packages.${system}.pg-stop}/bin/pg-stop
              echo "[stack] down"
            '';
          };

          toolkit = mk {
            name = "toolkit";
            text = ''
              echo "commands: ${lib.concatStringsSep " " (lib.attrNames self.packages.${system})}"
            '';
          };
        }
      );

      apps = forAll (
        system: _:
        lib.mapAttrs (name: drv: {
          type = "app";
          program = "${drv}/bin/${name}";
        }) self.packages.${system}
      );

      devShells = forAll (
        _system: pkgs: {
          default = pkgs.mkShell {
            # The list itself lives in `devPackagesFor` up in the `let`, because the
            # `toolchain-complete` check reads the SAME binding. ADAPT it there, not here — a
            # second list here is what the check exists to make impossible.
            packages = devPackagesFor pkgs;
            shellHook = dotenvLoader + ''
              # Same loader the commands use: a bare `nix develop` with no direnv should still see
              # the project's env. A no-op when direnv has already exported it.
              _load_project_dotenv "$PWD"
              echo "${project} dev shell — $(node --version)"
              echo "env: nix run .#env-doctor (${toString (builtins.length envNames)} catalogued vars)"
              echo "stack: nix run .#stack-up"
            '';
          };
        }
      );

      # Three named checks, each able to go red for a DIFFERENT reason — plus the packages alias.
      checks = forAll (
        system: pkgs:
        let
          # Narrow fileset for the checks that read the tree. A bare `./.` copies the whole
          # working tree into the store on every edit, so touching `node_modules` or `.next`
          # rebuilds a check that cannot even see them.
          #
          # ADAPT: the narrowest set the gate actually reads. `maybeMissing` is here only so the
          # template evaluates before these paths exist — DELETE it once they do, so a typo'd
          # path fails loudly instead of silently narrowing the gate to nothing.
          gateSrc = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              (lib.fileset.maybeMissing ./package.json)
              (lib.fileset.maybeMissing ./package-lock.json)
              (lib.fileset.maybeMissing ./src)
            ];
          };
        in
        # Aliasing `packages` into `checks` is DELIBERATE and measured on two Nix versions:
        # `nix flake check` only EVALUATES packages but BUILDS checks, so the alias promotes
        # evaluate→build. Every command above is a `writeShellApplication`, which runs shellcheck
        # at BUILD time — so this one line is a live shell-lint gate over every script in this
        # file, not a no-op. Prior art: `numtide/blueprint` does it by design, and
        # `NixOS/templates`' haskell-hello ships the identical line. Do not "clean it up".
        self.packages.${system}
        // {
          # OFF THE SHELF, not hand-written: `config.build.check` is treefmt-nix's own
          # `runCommandLocal` that copies the tree, `git init && add && commit`s it, runs
          # `treefmt --no-cache`, then `git diff --exit-code`. Upstream names it `formatting`
          # already, so the attribute name below is theirs, not an invention.
          # GOES RED WHEN: a tracked file is not formatted as ./treefmt.nix says it should be.
          formatting = treefmtEval.${system}.config.build.check self;

          # Hand-written, because nothing off the shelf does this — searched before building:
          # `mkShell` validates nothing, `devshell`'s `commands` asserts option SHAPE only,
          # `devenv`'s test lands in `packages` not `checks`, and a GitHub code search for
          # "toolchain-complete" returns 0 hits. So it uses the conventional property-assertion
          # idiom instead: `runCommandLocal` + `nativeBuildInputs`, asserting over a list.
          # GOES RED WHEN: a name in `requiredBins` resolves to no binary in `devPackagesFor` —
          # i.e. the dev shell silently stopped providing something a script depends on.
          toolchain-complete =
            pkgs.runCommandLocal "toolchain-complete" { nativeBuildInputs = devPackagesFor pkgs; }
              ''
                missing=""
                for bin in ${lib.escapeShellArgs requiredBins}; do
                  command -v "$bin" >/dev/null 2>&1 || missing="$missing $bin"
                done
                if [ -n "$missing" ]; then
                  echo "dev shell is missing:$missing" >&2
                  echo "add the package that SHIPS each one to devPackagesFor — a package name" >&2
                  echo "is not a binary name (yq-go ships yq, nodejs_22 ships node and npx)." >&2
                  exit 1
                fi
                echo "all ${toString (builtins.length requiredBins)} required binaries resolve." > "$out"
              '';
        }
        //
          # A loud sentinel with a NAMED escape. Three shapes, and the attribute NAME differs
          # between them on purpose: `nix flake show` then records which one this repo chose,
          # rather than leaving "no gate" as a silently absent attribute nobody can audit.
          (
            if !(projectGate ? command) && !(projectGate ? absent) then
              {
                # GOES RED WHEN: nobody has looked yet. Never a build failure — the message is
                # the whole point, so it must be unmistakably "edit this line", not "your code
                # is broken".
                project-gate = pkgs.runCommandLocal "project-gate-unwired" { } ''
                  echo "project-gate is UNWIRED (projectGate is a ${builtins.typeOf projectGate})" >&2
                  echo "— this is not a build failure." >&2
                  echo >&2
                  echo "Edit the 'projectGate' binding in flake.nix to ONE of:" >&2
                  echo "  projectGate = { command = \"npm test\"; packages = p: [ p.nodejs_22 ]; };" >&2
                  echo "  projectGate = { absent = \"<why this repo has no such command>\"; };" >&2
                  echo >&2
                  echo "'absent' means NO such command exists. A command that needs the network" >&2
                  echo "is not absent — vendor its dependencies so it runs offline. And note" >&2
                  echo "that sandbox=false is the DARWIN DEFAULT, so a green gate on a Mac is" >&2
                  echo "not evidence: re-check with --rebuild --option sandbox true." >&2
                  exit 1
                '';
              }
            else if projectGate ? absent then
              {
                # PASSES, and prints the reason into its own build log + output, so "this repo
                # has no gate" is a recorded decision with an author's reason attached.
                project-gate-absent = pkgs.runCommandLocal "project-gate-absent" { } ''
                  echo "no project gate, on purpose: ${projectGate.absent}" | tee "$out"
                '';
              }
            else
              {
                # GOES RED WHEN: the project's own command fails. The real gate.
                project-gate =
                  pkgs.runCommandLocal "project-gate" { nativeBuildInputs = projectGate.packages pkgs; }
                    ''
                      # The fileset arrives read-only out of the store, and most build tools want
                      # to write beside their inputs — so copy it and restore write permission
                      # rather than running in the store path.
                      #
                      # INTO A SUBDIRECTORY, and `chmod` THAT — never the build cwd itself. Under
                      # structured attrs `runCommandLocal`'s cwd also holds Nix's OWN
                      # `builder.json` and `.attr-*` files, and the LINUX sandbox refuses to let
                      # the builder re-mode them:
                      #   chmod: changing permissions of './builder.json': Operation not permitted
                      # It builds fine on darwin, which is exactly how the broken version shipped
                      # — that revision was verified by building `checks.aarch64-darwin.*` only.
                      # Measured on aarch64-linux 2026-10-02.
                      mkdir gate
                      cp -R ${gateSrc}/. gate/
                      chmod -R u+w gate
                      cd gate
                      ${projectGate.command}
                      touch "$out"
                    '';
              }
          )
      );
    };
}
