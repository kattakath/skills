"""Deterministic Claude Code hook gates of the scrape-harness PLUGIN, for any consumer project. Stdlib
only; every rule's names come from the project's pipeline.toml. One file, one entry per event:

  guard.py bash      PreToolUse(Bash)                     network politeness + secret egress
  guard.py write     PreToolUse(Write|Edit|NotebookEdit)  no data in the repo, no forbidden literals
  guard.py subagent  SubagentStop(scrape-harness:analyst)  the answer must validate as finding.v1
  guard.py session   SessionStart                         task seed from [[stages]] (context only)
  guard.py watch     plugin monitor (monitors.json)       one line per run transition / new incident (by id)
  guard.py steward   SubagentStop(scrape-harness:run-steward)  keep working while an incident is unacked
  guard.py teammate  TeammateIdle (run-steward only)      the same, for an Agent Teams teammate
  guard.py precompact PreCompact                          keep open incident ids in the summary

Every gate FAILS CLOSED: unreadable input or an internal error blocks (exit 2) with a reason,
because a hook that throws and exits non-2 lets the call through.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

DATA_EXT = {".jsonl", ".ndjson", ".csv", ".tsv", ".parquet", ".sqlite", ".db"}
NETWORK = ("none", "site", "paid")
NAME = r"[A-Z][A-Z0-9_]*"
CONSUMER_KEYS = ("cli", "env_prefix", "data_env", "state_env", "state_dirname", "secret_envs", "site_hosts")
# The pipeline.v1 this plugin was built against. The plugin auto-updates from the marketplace while a
# project's harness is pinned, so they can skew: a key this plugin does not know means the PLUGIN is
# older than the harness; a key it needs but cannot find means the HARNESS (or the pipeline) is older.
# Both fail closed with the update to run. A harness test asserts these equal its pipeline.v1 schema.
SCHEMA = "pipeline.v1"
KNOWN_TOP = frozenset(
    {
        "schema",
        "name",
        "consumer",
        "plugins",
        "claude",
        "groups",
        "stages",
        "utilities",
        "plan_outputs",
        "files",
        "offline_flags",
    }
)
KNOWN_CONSUMER = frozenset(
    {"cli", "env_prefix", "data_env", "state_env", "state_dirname", "default_site", "default_region",
     "approval_key_fingerprint", "secret_envs", "site_hosts"}
)  # fmt: skip
UPDATE_PLUGIN = "update the plugin: `claude plugin marketplace update kattakath && claude plugin update scrape-harness@kattakath`"
UPDATE_HARNESS = "update the harness: `nix flake update scrape-harness` (or add the key to pipeline.toml)"
# A NANP phone number that is not in the fictional 555-01xx block.
PHONE = re.compile(r"(?<!\d)(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)")


def block(reason: str) -> None:
    print(reason, file=sys.stderr)
    raise SystemExit(2)


def ask(reason: str) -> None:
    out = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "ask",
            "permissionDecisionReason": reason,
        }
    }
    print(json.dumps(out))
    raise SystemExit(0)


def project_dir() -> Path:
    """The consumer project (Claude Code sets CLAUDE_PROJECT_DIR for plugin hooks too); never the plugin."""
    return Path(os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()).resolve()


def literals() -> list[str]:
    """Forbidden literals from <PREFIX>_FORBIDDEN_LITERALS: a colon-separated list of files (e.g. the
    identity list and the site-word list, each kept once, outside the repo). Unset: no literal check.
    Set but ANY listed file unreadable: block (a typo must never silently disable the check)."""
    raw = os.environ.get(knob("FORBIDDEN_LITERALS"))
    if not raw:
        return []
    out = []
    for f in raw.split(":"):
        try:
            out += [ln.strip().lower() for ln in Path(f).expanduser().read_text().splitlines() if ln.strip()]
        except OSError as e:
            block(f"blocked: a forbidden-literals file is unreadable ({type(e).__name__}); failing closed")
    return out


def pipeline_file() -> Path:
    return Path(os.environ.get("SCRAPE_HARNESS_PIPELINE") or project_dir() / "pipeline.toml")


_DOC: dict | None = None


def doc() -> dict:
    """pipeline.toml, read once. Stdlib only (the hook runs outside the CLI's environment), so each
    reader below checks exactly the keys it uses and FAILS CLOSED on anything missing or malformed:
    an unreadable pipeline must never mean "no rules"."""
    global _DOC
    if _DOC is None:
        p = pipeline_file()
        try:
            _DOC = tomllib.loads(p.read_text(encoding="utf-8"))
        except (OSError, tomllib.TOMLDecodeError) as e:
            block(
                f"blocked: cannot read the pipeline declaration {p} ({type(e).__name__}: {e}); failing closed"
            )
        skew(_DOC, p)
    return _DOC


def skew(d: dict, p: Path) -> None:
    """Plugin/harness version mismatch, both directions, failing closed."""
    if d.get("schema") != SCHEMA:
        block(
            f"blocked: plugin/harness version mismatch: {p} declares schema {d.get('schema')!r}, this plugin "
            f"knows {SCHEMA!r}; {UPDATE_PLUGIN} (or, if the pipeline is the stray one, fix its `schema`); failing closed"
        )
    unknown = sorted(set(d) - KNOWN_TOP) + sorted(
        f"consumer.{k}"
        for k in set(d.get("consumer") or {}) - KNOWN_CONSUMER
        if isinstance(d.get("consumer"), dict)
    )
    if unknown:
        block(
            f"blocked: plugin/harness version mismatch: {p} has key(s) this plugin does not know "
            f"({', '.join(unknown)}): the plugin is OLDER than the harness; {UPDATE_PLUGIN}; failing closed"
        )


def consumer() -> dict:
    c = doc().get("consumer")
    if not isinstance(c, dict):
        block(f"blocked: {pipeline_file()}: `[consumer]` is missing; failing closed")
    for k in CONSUMER_KEYS:
        v = c.get(k)
        ok = (
            all(isinstance(x, str) and x for x in v)
            if isinstance(v, list)
            else isinstance(v, str) and bool(v)
        ) and (k not in ("secret_envs", "site_hosts") or isinstance(v, list))
        if k in ("env_prefix", "data_env", "state_env"):
            ok = ok and bool(re.fullmatch(NAME, v))
        if k == "secret_envs":
            ok = ok and all(re.fullmatch(NAME, x) for x in v)
        if k == "cli":
            ok = ok and bool(re.fullmatch(r"[a-z][a-z0-9-]*", v))
        if not ok:
            hint = (
                f" (if pipeline.toml is right, the harness is OLDER than this plugin: {UPDATE_HARNESS})"
                if k not in c
                else ""
            )
            block(f"blocked: {pipeline_file()}: consumer.{k} is missing or malformed{hint}; failing closed")
    return c


def knob(name: str) -> str:
    return f"{consumer()['env_prefix']}_{name}"


def cli_prefix() -> str:
    """`<cli> X`, `python -m scrape_harness.cli X`, or `nix run <flake> -- X`."""
    cli = re.escape(consumer()["cli"])
    return rf"(?:(?:^|[\s;&|(])(?:{cli}|python3?\s+-m\s+scrape_harness\.cli)|\bnix\s+run\b[^;&|]*?\s--)"


def network_rules() -> tuple[re.Pattern, dict[str, bool], re.Pattern]:
    """(network-command regex, name -> operator_only, offline-flag regex), from pipeline.toml."""
    p, doc_ = pipeline_file(), doc()
    cmds: dict[str, bool] = {}
    for table in ("stages", "utilities"):
        rows = doc_.get(table)
        if not isinstance(rows, list) or (table == "stages" and not rows):
            block(f"blocked: {p}: `{table}` is missing or not a list of tables; failing closed")
        for c in rows:
            name, net = (c.get("name"), c.get("network")) if isinstance(c, dict) else (None, None)
            if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)?", name):
                block(f"blocked: {p}: a {table} entry has no valid `name`; failing closed")
            if net not in NETWORK:
                block(f"blocked: {p}: {name}: `network` must be one of {', '.join(NETWORK)}; failing closed")
            if net != "none":
                cmds[name] = bool(c.get("operator_only", False))
    flags = doc_.get("offline_flags")
    if not isinstance(flags, list) or not all(isinstance(f, str) and f.startswith("--") for f in flags):
        block(f"blocked: {p}: `offline_flags` is missing or not a list of --flags; failing closed")
    names = sorted(cmds, key=len, reverse=True)  # "crawl resume" before any shorter prefix
    alts = "|".join(r"\s+".join(map(re.escape, n.split())) for n in names) or r"(?!)"
    network = re.compile(cli_prefix() + rf"\s+({alts})\b")
    offline = "|".join(r"[ =]".join(map(re.escape, f.split())) + r"(?![\w-])" for f in flags) or r"(?!)"
    return network, cmds, re.compile(offline)


# ── Bash ─────────────────────────────────────────────────────────────────────────────────────


def bash(event: dict) -> None:
    cmd = event["tool_input"]["command"]
    c = consumer()
    cli = c["cli"]
    for name in c["secret_envs"]:
        if re.search(rf"\$\{{?{name}\b", cmd):
            block(
                f"blocked: the command expands ${name}. Only {cli} reads it, from its environment; "
                "never echo, log or pass it on a command line."
            )
    if re.search(r"\bsecret\s+reveal\b", cmd):
        block(
            f"blocked: `secret reveal` prints a secret. Use `secret exec NAME=<item> -- {consumer()['cli']} ...` instead."
        )
    hosts = "|".join(map(re.escape, c["site_hosts"])) or r"(?!)"
    if re.search(rf"\b(curl|wget|http|xh)\b[^|;&]*(?:{hosts})", cmd, re.I):
        block(
            "blocked: direct HTTP to the crawled site. Each GET can count as a view of a real person's page; "
            f"pages are fetched only by `{cli}` through its rate-limited, refetch-ruled driver."
        )
    q = re.escape(cli)
    # `<cli> approve` is NOT gated here: since approvals are signed by the operator's Secure Enclave key
    # through Secretive, the Touch ID prompt is the gate. An agent may invoke it; only a finger completes it.
    if re.search(
        rf"(?:^|[\s;&|(]){q}\s+cooldown\s+clear\b|\bcooldown\s+clear\b.*--approve-operator|--approve-operator\b",
        cmd,
    ):
        ask(
            f"This clears a site cooldown (`{cli} cooldown clear`). That is the operator's decision; approve only if "
            "the operator asked for it, with the reason recorded."
        )
    if re.search(r"--approve-politeness-override\b", cmd):
        ask(
            "This command raises the crawl's concurrency/rate ceiling (--approve-politeness-override). Only the "
            "operator may approve that, for this run."
        )
    net_ok = rf"--approve-network\b|\b{knob('NETWORK_APPROVED')}=1\b"
    if re.search(net_ok, cmd):
        # However the CLI is reached (wrapper, script, nix run), an approval flag goes to the HUMAN:
        # an agent that adds the flag itself must not thereby approve its own run.
        ask(
            f"This command carries a network approval (--approve-network / {knob('NETWORK_APPROVED')}=1): it will make "
            "real requests (counted page views / paid API calls). Approve only if the operator asked for THIS run."
        )
    network, operator_only, offline_re = network_rules()
    m = network.search(cmd)
    if m and operator_only[" ".join(m.group(1).split())]:
        ask(
            f"`{cli} {m.group(1)}` is operator-only (pipeline.toml): it acts on the site directly (e.g. opens the "
            "dedicated browser HEADED to clear a challenge or gate by hand). Only the operator runs this."
        )
    if m:
        offline = offline_re.search(cmd)
        approved = re.search(net_ok, cmd)
        if not offline:
            if approved:
                ask(
                    f"`{cli} {m.group(1)}` will make real network requests (counted page views / paid API calls). "
                    "Approve only if the operator asked for THIS run."
                )
            block(
                f"blocked: `{cli} {m.group(1)}` touches the network. Plan it with --dry-run, or ask the operator "
                "and re-run with --approve-network (that run will still ask for confirmation)."
            )


# ── Write / Edit ─────────────────────────────────────────────────────────────────────────────


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def write(event: dict) -> None:
    ti = event["tool_input"]
    raw = ti.get("file_path") or ti.get("notebook_path")
    if not raw:
        block("blocked: no file path in the tool input")
    path = Path(raw).expanduser().resolve()
    c = consumer()
    state = os.environ.get(c["state_env"]) or str(
        Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state") / c["state_dirname"]
    )
    if _inside(path, Path(state).expanduser().resolve()):
        block(
            f"blocked: {path} is in the {c['cli']} state folder (browser profile, queues, approvals). Only `{c['cli']}` writes it."
        )
    data = os.environ.get(c["data_env"])
    if data and _inside(path, Path(data).expanduser().resolve()):
        block(
            f"blocked: {path} is in the data folder. Data files are written only by `{c['cli']}`, append-only and "
            "schema-validated; never by hand."
        )
    repo = project_dir()
    if _inside(path, repo):
        rel = path.relative_to(repo)
        if path.suffix.lower() in DATA_EXT or rel.parts[:1] == ("data",):
            block(
                f"blocked: {rel} looks like a data file. No data in this repo; it lives under ${c['data_env']}."
            )
        if path.suffix.lower() == ".html" and rel.parts[:2] != ("tests", "fixtures"):
            block(
                f"blocked: {rel}: HTML in the repo is only allowed as a synthetic test fixture (tests/fixtures/)."
            )
        text = "\n".join(str(ti.get(k, "")) for k in ("content", "new_string", "new_source"))
        low = text.lower()
        hit = next((lit for lit in literals() if lit in low), None)
        if hit:
            block(
                f"blocked: the new text contains a forbidden literal (entry {literals().index(hit) + 1} of "
                f"${knob('FORBIDDEN_LITERALS')}). This repo carries no operator identity."
            )
        for m in PHONE.finditer(text):
            if not (m.group(2) == "555" and m.group(3).startswith("01")):
                block(
                    f"blocked: {rel}: the new text contains a phone-number-shaped string. Use the fictional "
                    "555-01xx block in synthetic fixtures; real numbers never enter the repo."
                )


# ── SubagentStop ─────────────────────────────────────────────────────────────────────────────


def _li() -> list[str]:
    cli = consumer()["cli"]
    if shutil.which(cli):
        return [cli]
    if shutil.which("nix"):
        return ["nix", "run", f"{project_dir()}#default", "--"]
    block(f"blocked: cannot validate the agent's output: neither `{cli}` nor `nix` is on PATH.")
    return []


def subagent(event: dict) -> None:
    msg = event.get("last_assistant_message")
    if not isinstance(msg, str) or not msg.strip():
        block(
            "Your final message must be exactly one JSON object valid against schemas/finding.v1.schema.json."
        )
    r = subprocess.run(
        [*_li(), "validate", "finding.v1", "-"], input=msg, capture_output=True, text=True, timeout=120
    )
    if r.returncode != 0:
        if event.get("stop_hook_active"):
            # One retry only: `<cli> findings append` re-validates anyway, so stopping here cannot let
            # an invalid record into the register, and it prevents an endless block loop.
            print(
                "analyst output still invalid; the caller's `findings append` will reject it.",
                file=sys.stderr,
            )
            raise SystemExit(0)
        block(
            "Your output is not a valid finding.v1. Reply again with ONLY the corrected JSON object.\n"
            + (r.stderr or r.stdout)[-1500:]
        )


# ── Incidents: keep the steward on them, and through compaction ─────────────────────────────────


def _unacked_reason() -> str | None:
    try:
        open_ = open_incidents()
    except (
        SystemExit
    ):  # a broken pipeline.toml: the Bash gate already blocks everything; do not trap the agent
        return None
    if not open_:
        return None
    cli = consumer()["cli"]
    ids = ", ".join(f"{r['id']} ({r.get('kind')} in {r.get('stage')})" for r in open_)
    return (
        f"Unacked incident(s): {ids}. Before stopping: read {incidents_file()}, follow the runbook-stop skill, "
        f'report to the operator, then `{cli} incidents ack <id> --note "<what was done or decided>"` for each. '
        "If only the operator can act, ack with a note saying exactly what you asked him for."
    )


def steward(event: dict) -> None:
    """SubagentStop(scrape-harness:run-steward): exit 2 keeps it working (its stderr is the next
    instruction) while any incident is unacked."""
    reason = _unacked_reason()
    if reason:
        print(reason, file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(0)


def teammate(event: dict) -> None:
    """TeammateIdle (no matcher: fires for every teammate): only a teammate named run-steward is kept
    working, by exit 2, while an incident is unacked."""
    if event.get("teammate_name") != "run-steward":
        raise SystemExit(0)
    steward(event)


def precompact(event: dict) -> None:
    """PreCompact: stdout (exit 0) is instructions for the compaction summary: keep open incident ids."""
    try:
        open_ = open_incidents()
    except SystemExit:
        raise SystemExit(0) from None
    if open_:
        print(
            "Preserve verbatim in the summary: these scrape-harness incidents are OPEN (unacked): "
            + "; ".join(
                f"{r['id']} {r.get('kind')} in {r.get('stage')} (run {r.get('run_id')})" for r in open_
            )
            + f". The record is {incidents_file()}."
        )
    raise SystemExit(0)


# ── SessionStart: seed the task list from [[stages]] ─────────────────────────────────────────


def task_seed() -> list[dict]:
    """One task per declared stage, in order, each blocked by the one before. Agents may split, merge,
    fan out or skip them; the stage name stays in the subject so the run card and the task list agree."""
    c, stages = consumer(), doc().get("stages")
    if not isinstance(stages, list) or not stages:
        raise ValueError("`stages` is missing or empty")
    cli, n, out = c["cli"], len(stages), []
    for i, st in enumerate(stages, 1):
        name, net = st.get("name"), st.get("network")
        if not isinstance(name, str) or net not in NETWORK:
            raise ValueError(f"stage {i} has no valid name/network")
        how = (
            f"Networked ({net}): plan it with `{cli} {name} --plan`; the operator approves the plan; then run "
            f"`{cli} {name}`. Never add an approval flag yourself."
            if net != "none"
            else f"Offline: run `{cli} {name}`."
        )
        io = "; ".join(f"{k}: {', '.join(st.get(k) or []) or 'none'}" for k in ("inputs", "outputs"))
        out.append(
            {
                "subject": f"Stage {i}/{n}: {name}",
                "activeForm": f"Running stage {i}/{n} ({name})",
                "description": f"{how} {io}.",
                "blockedBy": [f"Stage {i - 1}/{n}: {stages[i - 2]['name']}"] if i > 1 else [],
            }
        )
    for inc in open_incidents():  # an open incident blocks its stage's task until it is acked
        subject = f"Incident {inc['id']}: {inc.get('kind')} in {inc.get('stage')}"
        out.append(
            {
                "subject": subject,
                "activeForm": f"Handling incident {inc['id']}",
                "description": f"{inc.get('reason')} Follow runbook-stop, report, then `{cli} incidents ack {inc['id']} --note ...`.",
                "blockedBy": [],
            }
        )
        for t in out:
            if t["subject"].endswith(f": {inc.get('stage')}"):
                t["blockedBy"].append(subject)
    return out


def session(event: dict) -> None:
    """SessionStart cannot block; it adds context. A broken pipeline is SAID, never hidden."""
    try:
        seed = task_seed()
    except SystemExit:  # consumer()/doc() block on a broken pipeline: report it instead
        seed = None
    except Exception:  # noqa: BLE001
        seed = None
    if seed is None:
        text = (
            f"scrape-harness: {pipeline_file()} is missing or invalid, so every Bash call is blocked until it "
            "is fixed. Fix pipeline.toml first."
        )
    else:
        text = (
            "scrape-harness task seed (from pipeline.toml [[stages]]). If the task list is empty, create one "
            "task per entry with TaskCreate (subject, description, activeForm), then set blockedBy as listed. "
            "You may split, merge, fan out or mark tasks done/skipped as the work requires; keep the "
            "'Stage i/N: name' prefix so the run card and the task list agree.\n"
            + json.dumps(seed, ensure_ascii=False)
        )
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}}))
    raise SystemExit(0)


# ── Monitor: doorbells from STATE/status.json (a plugin monitor runs `run watch`) ──────────────

WATCH_EVERY_S = float(os.environ.get("SCRAPE_HARNESS_WATCH_EVERY", "5"))  # tests use a short tick
RUNG: set = set()  # incident ids the monitor already announced
STALE_S = 600


def status_file() -> Path:
    c = consumer()
    root = os.environ.get(c["state_env"]) or str(
        Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state") / c["state_dirname"]
    )
    return Path(root).expanduser() / "status.json"


def incidents_file() -> Path:
    return status_file().parent / "ops" / "incidents.jsonl"


def incident_lines() -> list[dict]:
    try:
        text = incidents_file().read_text()
    except OSError:
        return []
    out = []
    for line in text.splitlines():
        try:
            out.append(json.loads(line))
        except ValueError:
            continue  # the CLI validates on read; a hook only needs the ids
    return out


def open_incidents() -> list[dict]:
    lines = incident_lines()
    acked = {r.get("id") for r in lines if r.get("event") == "acked"}
    return [r for r in lines if r.get("event") == "opened" and r.get("id") not in acked]


def open_stall(st: dict, minutes: int) -> dict | None:
    """The monitor's own incident (incident.v1, same shape the CLI writes): a run with no progress.
    Appended once per run while it stays open."""
    import secrets
    from datetime import UTC, datetime

    if any(r.get("kind") == "stall" and r.get("run_id") == st.get("run_id") for r in open_incidents()):
        return None
    now = datetime.now(UTC)
    rec = {
        "schema": "incident.v1",
        "id": f"INC-{now:%Y%m%dT%H%M%SZ}-{secrets.token_hex(3)}",
        "event": "opened",
        "at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "kind": "stall",
        "code": None,
        "run_id": st.get("run_id"),
        "stage": st.get("command"),
        "reason": f"no progress for {minutes} min (status file untouched, run still marked running)",
    }
    f = incidents_file()
    f.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with f.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, sort_keys=True) + "\n")
    return rec


def doorbell(inc: dict) -> str:
    cli = consumer()["cli"]
    return (
        f"scrape-harness INCIDENT {inc['id']}: {inc.get('kind')} in {inc.get('stage')} (run {inc.get('run_id')}): "
        f"{inc.get('reason')}. Record: {incidents_file()}. Read the runbook-stop skill, report, then "
        f"`{cli} incidents ack {inc['id']} --note \"<what was done>\"`. Create a task 'Incident {inc['id']}' "
        "that blocks the stopped stage's task until it is acked."
    )


def transitions(prev: dict | None, cur: dict | None, now: float) -> list[str]:
    """The doorbell lines for one tick: a new run, a status change, a new challenge, a stale run.
    Each line names the files that hold the truth; the line itself is only a pointer."""
    if not cur:
        return []
    rid, where = cur.get("run_id"), f"status {status_file()}; log {cur.get('log')}"
    head = f"scrape-harness: {cur.get('command')} {cur.get('stage')} ({rid})"
    out = []
    if not prev or prev.get("run_id") != rid:
        out.append(f"{head}: {cur.get('status')}. {where}")
    elif prev.get("status") != cur.get("status"):
        tail = (
            " Read the runbook-stop skill before acting."
            if cur.get("status") in ("stopped", "aborted")
            else ""
        )
        out.append(f"{head}: {prev.get('status')} -> {cur.get('status')}.{tail} {where}")
    if prev and prev.get("run_id") == rid and cur.get("challenges", 0) > prev.get("challenges", 0):
        out.append(f"{head}: challenge #{cur['challenges']}. {where}")
    try:
        from datetime import datetime

        age = now - datetime.fromisoformat(str(cur.get("updated_at")).replace("Z", "+00:00")).timestamp()
    except ValueError:
        age = 0
    was_stale = bool(prev and prev.get("_stale"))
    if cur.get("status") == "running" and age > STALE_S and not was_stale:
        cur["_stale"] = True
        out.append(f"{head}: no progress for {int(age // 60)} min. {where}")
        inc = open_stall(cur, int(age // 60))
        if inc:
            RUNG.add(inc["id"])
            out.append(doorbell(inc))
    elif was_stale and age <= STALE_S:
        cur["_stale"] = False
    else:
        cur["_stale"] = was_stale
    return out


def watch(_event: dict | None = None) -> None:
    """Long-running: print one line per transition, flushed, forever. Never blocks anything."""
    import time

    def current() -> dict | None:
        global _DOC
        _DOC = None  # re-read pipeline.toml each tick: a fix takes effect without a restart
        try:
            return json.loads(status_file().read_text())
        except SystemExit:  # consumer()/doc() refused a broken pipeline.toml
            raise
        except (OSError, ValueError):
            return None

    prev, said_broken = None, False
    try:
        prev = current()  # what is already there is not news
        if prev:
            prev["_stale"] = False
        RUNG.update(r.get("id") for r in incident_lines())
    except SystemExit:
        pass
    rung = RUNG
    while True:
        try:
            cur = current()
            said_broken = False
        except SystemExit:
            if not said_broken:
                print(
                    f"scrape-harness: {pipeline_file()} is missing or invalid; watching paused until fixed",
                    flush=True,
                )
                said_broken = True
            time.sleep(WATCH_EVERY_S)
            continue
        for line in transitions(prev, cur, time.time()):
            print(line, flush=True)
        for inc in open_incidents():  # every newly opened incident rings once, by id
            if inc.get("id") not in rung:
                rung.add(inc.get("id"))
                print(doorbell(inc), flush=True)
        prev = cur or prev
        time.sleep(WATCH_EVERY_S)


def main() -> None:
    gates = {
        "bash": bash,
        "write": write,
        "subagent": subagent,
        "session": session,
        "steward": steward,
        "teammate": teammate,
        "precompact": precompact,
    }
    if sys.argv[1:2] == ["watch"]:  # the monitor: no stdin event, runs until the session ends
        watch()
    try:
        gate = gates[sys.argv[1]]
        event = json.load(sys.stdin)
        gate(event)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        if sys.argv[1:2] in (["session"], ["steward"], ["teammate"], ["precompact"]):
            # context-only / keep-working gates: an internal error must neither block compaction nor
            # trap an agent in a loop. The POLICY gates (bash, write, subagent) fail closed below.
            print(f"hook error ({type(e).__name__}: {e}); ignored for {sys.argv[1]}", file=sys.stderr)
            raise SystemExit(0) from None
        block(f"hook error ({type(e).__name__}: {e}); failing closed")


if __name__ == "__main__":
    main()
