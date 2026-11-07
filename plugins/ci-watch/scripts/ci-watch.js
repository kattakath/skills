#!/usr/bin/env node
// @ts-check
/**
 * ci-watch: wait on every GitHub Actions run that a commit pushed to the default branch
 * triggered. SILENT when they pass. In every other case (red, nothing checked it, still
 * running at the ceiling, or the watch itself failing) it writes a JSON report and prints
 * a short summary.
 *
 *   node ci-watch.js [--sha <sha>] [--repo <owner/name>] [--cwd <dir>]
 *       CLI. Exit 0 green, 1 red, 3 no runs, 4 still running, 64 usage/lookup error.
 *   node ci-watch.js --hook
 *       PostToolUse(Bash) asyncRewake hook. Exit 0 on green or not-a-push-to-default.
 *       Anything else exits 2, which wakes the session with the summary (stderr).
 *
 * Everything comes from `gh` and `git`; there is no model in this loop. The traps it is
 * built around are silent-instruments' §C:
 * - A short sha matches no runs (C10), so every sha is a full 40 chars.
 * - Zero runs, or runs that all skipped, is NOT green: something must have succeeded.
 * - Runs register late (a `workflow_run` chain starts when its parent ENDS), so "done"
 *   means every run completed AND the set has not changed for SETTLE_S.
 * - A commit can carry older runs from a PR or another branch; the hook counts only runs
 *   created since the push.
 * - `--log-failed` loses step attribution, so the failing step's lines come from the raw
 *   job log, cut by the step's own start/end timestamps.
 *
 * Tunables (env, seconds): CI_WATCH_APPEAR_S 180, CI_WATCH_SETTLE_S 90, CI_WATCH_POLL_S 20,
 * CI_WATCH_CEILING_S 2700 (clamped to 2700). Each gh call times out at 30 s and a report
 * reads at most 5 failed jobs, so the worst case stays under hooks.json's 3600 s timeout
 * and the script reports STILL_RUNNING instead of being killed silently. CI_WATCH_DIR is
 * the report dir (default $CLAUDE_PLUGIN_DATA, else <tmp>/ci-watch). CI_WATCH_GH /
 * CI_WATCH_GIT swap the binaries (tests).
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** @typedef {import('@anthropic-ai/claude-agent-sdk').PostToolUseHookInput} PostToolUseHookInput */
/** @typedef {{ repo: string, branch: string, sha: string, since?: number }} Target */
/** @typedef {{ databaseId: number, workflowName: string, event: string, status: string, conclusion: string, url: string, createdAt: string }} Run */
/** @typedef {{ number: number, name: string, conclusion: string, startedAt?: string, completedAt?: string }} Step */
/** @typedef {{ databaseId: number, name: string, conclusion: string, url: string, steps: Step[] }} Job */
/** @typedef {{ n: number, text: string }} LogLine */
/**
 * @typedef {{
 *   run_id: number, workflow: string, run_url: string, conclusion: string,
 *   job_id: number | null, job: string | null, job_url: string | null,
 *   step: { number: number, name: string, started_at: string | null, completed_at: string | null } | null,
 *   log: { total_lines: number, error_lines: number[], lines: LogLine[] } | { error: string } | null,
 *   commands: { view: string, rerun: string }
 * }} Failure
 */
/**
 * @typedef {{
 *   schema: "ci-watch/report@1", status: "RED" | "NO_RUNS" | "STILL_RUNNING" | "WATCH_FAILED",
 *   repo: string, branch: string, sha: string, subject: string, commit_url: string,
 *   changed_files: string[], started_at: string, finished_at: string, note: string,
 *   runs: { id: number, workflow: string, event: string, status: string, conclusion: string, url: string }[],
 *   failures: Failure[], pending: string[]
 * }} Report
 */

const PASS = new Set(["success", "skipped", "neutral"]);
const SHA40 = /^[0-9a-f]{40}$/;
const EXIT = { GREEN: 0, RED: 1, NO_RUNS: 3, STILL_RUNNING: 4, USAGE: 64 };
const MAX_FAILED_JOBS = 5;

/** @param {string} name @param {number} dflt */
const num = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
};
const T = {
  appear: num("CI_WATCH_APPEAR_S", 180),
  settle: num("CI_WATCH_SETTLE_S", 90),
  poll: num("CI_WATCH_POLL_S", 20),
  ceiling: Math.min(num("CI_WATCH_CEILING_S", 2700), 2700),
};

/** @param {number} s */
const sleep = (s) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(s * 1000));
const now = () => new Date().toISOString();
const reportDir = () => process.env.CI_WATCH_DIR || process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), "ci-watch");

/**
 * @param {string} bin @param {string[]} args @param {string} [cwd]
 * @returns {string}
 */
function capture(bin, args, cwd) {
  return execFileSync(bin, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20, timeout: 30_000 });
}
const GH = process.env.CI_WATCH_GH || "gh";
const GIT = process.env.CI_WATCH_GIT || "git";
/** @param {string[]} args @param {string} [cwd] @returns {any} */
const gh = (args, cwd) => JSON.parse(capture(GH, args, cwd));
/** @param {string[]} args @param {string} cwd */
const git = (args, cwd) => capture(GIT, args, cwd).trim();

/**
 * @param {{ cwd?: string, repo?: string }} o
 * @returns {{ repo: string, branch: string }}
 */
function repoOf(o) {
  const view = gh(["repo", "view", ...(o.repo ? [o.repo] : []), "--json", "nameWithOwner,defaultBranchRef"], o.cwd);
  return { repo: String(view.nameWithOwner), branch: String(view.defaultBranchRef && view.defaultBranchRef.name) };
}

/** Expand any ref or short sha to the full sha through the API. @param {string} repo @param {string} ref */
function fullSha(repo, ref) {
  const sha = String(gh(["api", `repos/${repo}/commits/${ref}`]).sha);
  if (!SHA40.test(sha)) throw new Error(`could not resolve a full sha for ${ref}`);
  return sha;
}

/**
 * Poll until every run for the sha is completed AND the set (ids and statuses) has not
 * changed for SETTLE_S. Completion itself is a change, so a run that a parent's completion
 * triggers is still seen.
 * @param {Target} t
 * @returns {{ status: "DONE" | "NO_RUNS" | "STILL_RUNNING", runs: Run[] }}
 */
function waitForRuns(t) {
  const fields = "databaseId,workflowName,event,status,conclusion,url,createdAt";
  const t0 = Date.now();
  let lastChange = t0;
  let key = "";
  /** @type {Run[]} */
  let runs = [];
  for (;;) {
    /** @type {Run[]} */
    const seen = gh(["run", "list", "--repo", t.repo, "--commit", t.sha, "--limit", "100", "--json", fields]);
    runs = t.since ? seen.filter((r) => Date.parse(r.createdAt) >= /** @type {number} */ (t.since)) : seen;
    const k = runs.map((r) => `${r.databaseId}:${r.status}`).sort().join(",");
    if (k !== key) {
      key = k;
      lastChange = Date.now();
    }
    const elapsed = (Date.now() - t0) / 1000;
    const quiet = (Date.now() - lastChange) / 1000 >= T.settle;
    if (runs.length === 0 && elapsed >= T.appear) return { status: "NO_RUNS", runs };
    if (runs.length > 0 && runs.every((r) => r.status === "completed") && quiet) return { status: "DONE", runs };
    if (elapsed >= T.ceiling) return { status: "STILL_RUNNING", runs };
    sleep(T.poll);
  }
}

/** @param {string} s */
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const TS = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?(.*)$/;

/**
 * The failing step's lines from a raw job log, with real 1-based line numbers.
 * The step's [startedAt, completedAt] window cuts the log. Inside it the excerpt runs
 * from 30 lines before the first `##[error]` through the last one; without a window (no
 * timestamps) it falls back to the whole log. Over 60 lines, the FIRST error keeps its
 * run-up (usually the root cause) and the tail keeps the last errors.
 * @param {string} raw @param {Step | null} step
 * @returns {{ total_lines: number, error_lines: number[], lines: LogLine[] }}
 */
function excerpt(raw, step) {
  const all = raw.split(/\r?\n/).map((l, i) => {
    const m = TS.exec(l);
    return { n: i + 1, ts: m ? Date.parse(m[1]) : NaN, text: stripAnsi(m ? m[2] : l) };
  });
  const from = step && step.startedAt ? Date.parse(step.startedAt) : NaN;
  const to = step && step.completedAt ? Date.parse(step.completedAt) + 1000 : NaN;
  let pool = all.filter((l) => !Number.isNaN(from) && l.ts >= from && (Number.isNaN(to) || l.ts <= to));
  if (pool.length === 0) pool = all;
  const errs = pool.filter((l) => l.text.includes("##[error]"));
  let lines;
  if (errs.length) {
    const first = errs[0].n;
    const last = errs[errs.length - 1].n;
    lines = pool.filter((l) => l.n >= Math.max(pool[0].n, first - 30) && l.n <= Math.min(pool[pool.length - 1].n, last + 3));
    if (lines.length > 60) {
      const head = lines.filter((l) => l.n >= first - 25 && l.n <= first + 4);
      lines = [...head, ...lines.filter((l) => l.n > first + 4).slice(-30)];
    }
  } else {
    lines = pool.slice(-40);
  }
  return { total_lines: all.length, error_lines: errs.map((l) => l.n), lines: lines.map(({ n, text }) => ({ n, text })) };
}

/**
 * @param {Target} t @param {Run} run
 * @returns {{ f: Failure, step: Step | null }[]}
 */
function failuresOf(t, run) {
  const base = {
    run_id: run.databaseId,
    workflow: run.workflowName,
    run_url: run.url,
    conclusion: run.conclusion,
    commands: {
      view: `gh run view ${run.databaseId} --repo ${t.repo}`,
      rerun: `gh run rerun ${run.databaseId} --repo ${t.repo} --failed`,
    },
  };
  /** @type {Job[]} */
  let jobs;
  try {
    jobs = gh(["run", "view", String(run.databaseId), "--repo", t.repo, "--json", "jobs"]).jobs || [];
  } catch (e) {
    return [{ f: { ...base, job_id: null, job: null, job_url: null, step: null, log: { error: errMsg(e) } }, step: null }];
  }
  const bad = jobs.filter((j) => !PASS.has(j.conclusion));
  if (bad.length === 0) return [{ f: { ...base, job_id: null, job: null, job_url: null, step: null, log: null }, step: null }];
  return bad.map((j) => {
    const step = (j.steps || []).find((s) => s.conclusion === "failure") || (j.steps || []).find((s) => !PASS.has(s.conclusion)) || null;
    /** @type {Failure} */
    const f = {
      ...base,
      job_id: j.databaseId,
      job: j.name,
      job_url: j.url,
      step: step && { number: step.number, name: step.name, started_at: step.startedAt || null, completed_at: step.completedAt || null },
      log: null,
    };
    return { f, step };
  });
}

/** @param {unknown} e */
function errMsg(e) {
  const x = /** @type {{ stderr?: unknown, message?: unknown }} */ (e || {});
  return String(x.stderr || x.message || e).trim().split("\n").slice(0, 3).join(" | ");
}

/**
 * @param {Target} t @param {Report["status"]} status @param {Run[]} runs @param {string} startedAt @param {string} [note]
 * @returns {Report}
 */
function buildReport(t, status, runs, startedAt, note = "") {
  let subject = "";
  /** @type {string[]} */
  let files = [];
  try {
    const c = gh(["api", `repos/${t.repo}/commits/${t.sha}`]);
    subject = String(c.commit && c.commit.message).split("\n")[0];
    files = (c.files || []).map((/** @type {{ filename: string }} */ f) => f.filename).slice(0, 100);
  } catch {
    // The report still names the sha; a missing subject is not worth failing over.
  }
  const red = status === "RED" ? runs.filter((r) => r.status === "completed" && !PASS.has(r.conclusion)) : [];
  // Logs only for the first MAX_FAILED_JOBS jobs: each is a download with its own timeout,
  // and the hook's total runtime has to stay under its timeout.
  const found = red.flatMap((r) => failuresOf(t, r));
  found.forEach(({ f, step }, i) => {
    if (f.job_id === null || f.log) return;
    if (i >= MAX_FAILED_JOBS) {
      f.log = { error: `log not fetched: only the first ${MAX_FAILED_JOBS} failed jobs are read` };
      return;
    }
    try {
      f.log = excerpt(capture(GH, ["api", `repos/${t.repo}/actions/jobs/${f.job_id}/logs`, "--allow-escape-sequences"]), step);
    } catch (e) {
      f.log = { error: errMsg(e) };
    }
  });
  return {
    schema: "ci-watch/report@1",
    status,
    repo: t.repo,
    branch: t.branch,
    sha: t.sha,
    subject,
    commit_url: `https://github.com/${t.repo}/commit/${t.sha}`,
    changed_files: files,
    started_at: startedAt,
    finished_at: now(),
    note,
    runs: runs.map((r) => ({ id: r.databaseId, workflow: r.workflowName, event: r.event, status: r.status, conclusion: r.conclusion, url: r.url })),
    failures: found.map((x) => x.f),
    pending: runs.filter((r) => r.status !== "completed").map((r) => r.workflowName),
  };
}

/** @param {Report} r @param {string} file */
function summary(r, file) {
  const out = [`ci-watch ${r.status}: ${r.repo}@${r.sha.slice(0, 12)} ${JSON.stringify(r.subject)}`];
  if (r.note) out.push(`- ${r.note}`);
  if (r.status === "STILL_RUNNING") out.push(`- still running after ${T.ceiling}s: ${r.pending.join(", ")}`);
  for (const f of r.failures) {
    const where = [f.workflow, f.job, f.step && `step ${f.step.number} "${f.step.name}"`].filter(Boolean).join(" > ");
    out.push(`- ${f.conclusion.toUpperCase()} ${where}  ${f.job_url || f.run_url}`);
    const log = f.log;
    if (log && "lines" in log) {
      for (const l of log.lines.filter((x) => log.error_lines.includes(x.n)).slice(0, 3)) out.push(`    L${l.n}: ${l.text.slice(0, 200)}`);
    } else if (log && "error" in log) {
      out.push(`    (log unavailable: ${log.error})`);
    }
    out.push(`    ${f.commands.view} --log-failed   |   ${f.commands.rerun}`);
  }
  out.push(`Full report (job/step ids, numbered log lines, changed files): ${file}`);
  return out.join("\n");
}

/** @param {Report} r @returns {string} */
function save(r) {
  const dir = reportDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${r.repo.replace("/", "--")}-${r.sha}.json`);
  fs.writeFileSync(file, JSON.stringify(r, null, 2) + "\n");
  return file;
}

/**
 * Watch one target to the end. Returns the exit code and, unless green, the summary.
 * @param {Target} t
 * @returns {{ code: number, text: string }}
 */
function watch(t) {
  const startedAt = now();
  const w = waitForRuns(t);
  const red = w.runs.some((r) => r.status === "completed" && !PASS.has(r.conclusion));
  const checked = w.runs.some((r) => r.conclusion === "success");
  if (w.status === "DONE" && !red && checked) return { code: EXIT.GREEN, text: "" };
  /** @type {"RED" | "NO_RUNS" | "STILL_RUNNING"} */
  const status = red ? "RED" : w.status === "STILL_RUNNING" ? "STILL_RUNNING" : "NO_RUNS";
  const note =
    status !== "NO_RUNS"
      ? ""
      : w.runs.length
        ? `all ${w.runs.length} run(s) were skipped or neutral; nothing checked this commit`
        : `no workflow run appeared within ${T.appear}s; nothing checked this commit`;
  const r = buildReport(t, status, w.runs, startedAt, note);
  return { code: EXIT[status], text: summary(r, save(r)) };
}

/**
 * Find the push in a Bash command. Returns the directory it ran in, its arguments and
 * the bare word list, or null when no segment is a real `git … push` (dry runs, deletes,
 * tag-only pushes and help are not). A `cd <dir>` earlier in the command, or
 * `git -C <dir>`, moves the directory. Wrappers (sudo, env, command, exec, nice, time,
 * `nix develop -c`, a subshell paren) are skipped.
 * @param {string} cmd @param {string} cwd
 * @returns {{ dir: string, args: string[] } | null}
 */
function findPush(cmd, cwd) {
  let dir = cwd;
  for (const raw of cmd.split(/&&|\|\||;|\||\n/)) {
    const w = raw.trim().replace(/^\(+/, "").replace(/\)+$/, "").trim().split(/\s+/).filter(Boolean);
    let i = 0;
    for (;;) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i] || "")) i++;
      else if (["sudo", "command", "exec", "nice", "time", "env"].includes(w[i])) i++;
      else if (w[i] === "nix" && w[i + 1] === "develop") {
        const c = w.indexOf("-c", i);
        if (c < 0) break;
        i = c + 1;
      } else break;
    }
    if (w[i] === "cd" && w[i + 1]) {
      dir = path.resolve(dir, w[i + 1].replace(/^~(?=\/|$)/, os.homedir()));
      continue;
    }
    if (!(w[i] === "git" || (w[i] || "").endsWith("/git"))) continue;
    let gdir = dir;
    let j = i + 1;
    while (j < w.length && w[j].startsWith("-")) {
      if (w[j] === "-C" && w[j + 1]) gdir = path.resolve(gdir, w[j + 1].replace(/^~(?=\/|$)/, os.homedir()));
      j += w[j] === "-C" || w[j] === "-c" ? 2 : 1;
    }
    if (w[j] !== "push") continue;
    const args = w.slice(j + 1);
    if (args.some((a) => /^(--dry-run|-n|--delete|-d|--tags|--help|-h|--mirror)$/.test(a) || a.startsWith(":"))) continue;
    return { dir: gdir, args };
  }
  return null;
}

/**
 * The source and destination of a push: `git push [remote] [src[:dst]]`. Bare `git push`
 * pushes HEAD to the current branch's name (the default `push.default=simple` shape).
 * @param {string[]} args @param {string} dir
 * @returns {{ src: string, dst: string }}
 */
function refspecOf(args, dir) {
  const pos = args.filter((a) => !a.startsWith("-"));
  const spec = pos[1];
  const strip = (/** @type {string} */ r) => r.replace(/^\+/, "").replace(/^refs\/heads\//, "");
  if (!spec) return { src: "HEAD", dst: git(["symbolic-ref", "--short", "HEAD"], dir) };
  const [s, d] = spec.split(":");
  const src = strip(s) || "HEAD";
  return { src, dst: d === undefined ? (src === "HEAD" ? git(["symbolic-ref", "--short", "HEAD"], dir) : src) : strip(d) };
}

/** True when `sha` is the tip of `branch` or behind it (so it is ON the branch). */
function onBranch(/** @type {string} */ repo, /** @type {string} */ sha, /** @type {string} */ branch) {
  const st = String(gh(["api", `repos/${repo}/compare/${sha}...${branch}`]).status);
  return st === "identical" || st === "ahead";
}

/**
 * PostToolUse(Bash) entry. Before a push is identified, anything unexpected exits 0
 * (this hook sees every Bash call). After it, every failure wakes the session: a push
 * that landed and is not watched must never look like a pass.
 */
function hook() {
  const hookStart = Date.now();
  /** @type {PostToolUseHookInput} */
  let evt;
  try {
    evt = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return 0;
  }
  const cmd = String((/** @type {{ command?: unknown }} */ (evt && evt.tool_input) || {}).command || "");
  const push = findPush(cmd, evt.cwd || process.cwd());
  if (!push) return 0;
  const resp = /** @type {{ stderr?: unknown, stdout?: unknown }} */ (evt.tool_response || {});
  if (/\[rejected\]|error: failed to push/.test(String(resp.stderr || "") + String(resp.stdout || ""))) return 0;

  // Quiet ONLY when there is nothing to watch: not a git checkout, a non-GitHub remote, or
  // a checkout with no branch. "Could not look it up" is a different thing and wakes below.
  if (!fs.existsSync(push.dir)) {
    process.stderr.write(`ci-watch WATCH_FAILED: a push ran in ${push.dir}, which does not exist here (a shell variable?). Watch it by hand with --sha.\n`);
    return 2;
  }
  /** @type {{ src: string, dst: string }} */
  let spec;
  let pushed;
  try {
    if (git(["rev-parse", "--is-inside-work-tree"], push.dir) !== "true") return 0;
    const remote = push.args.filter((a) => !a.startsWith("-"))[0] || "origin";
    const url = /[:/]/.test(remote) ? remote : git(["config", "--get", `remote.${remote}.url`], push.dir);
    if (!/github\.com[:/]/.test(url)) return 0;
    spec = refspecOf(push.args, push.dir);
    pushed = git(["rev-parse", `${spec.src}^{commit}`], push.dir);
  } catch {
    return 0;
  }
  // From here a GitHub push happened, so every failure must wake the session.
  const label = `${push.dir}@${String(pushed).slice(0, 12)}`;
  try {
    const rb = repoOf({ cwd: push.dir });
    if (spec.dst !== rb.branch) return 0; // a feature-branch push
    const sha = fullSha(rb.repo, pushed);
    if (!onBranch(rb.repo, sha, rb.branch)) return 0; // the push did not land (rejected, or rewritten)
    // One watcher per sha: exclusive create, so a second hook for the same push exits here.
    try {
      fs.mkdirSync(reportDir(), { recursive: true });
      fs.closeSync(fs.openSync(path.join(reportDir(), `watched-${rb.repo.replace("/", "--")}-${sha}`), "wx"));
    } catch (e) {
      if (/** @type {{ code?: string }} */ (e).code === "EEXIST") return 0;
      // An unwritable dir only costs the dedupe; the watch still runs.
    }
    const r = watch({ repo: rb.repo, branch: rb.branch, sha, since: hookStart - 120_000 });
    if (r.code === EXIT.GREEN) return 0;
    process.stderr.write(r.text + "\n");
  } catch (e) {
    process.stderr.write(`ci-watch WATCH_FAILED: ${label} — the push landed but could not be watched: ${errMsg(e)}\n`);
  }
  return 2;
}

/** @param {string[]} argv */
function cli(argv) {
  /** @type {{ cwd?: string, repo?: string, sha?: string }} */
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if ((k === "--sha" || k === "--repo" || k === "--cwd") && v) {
      o[/** @type {"sha" | "repo" | "cwd"} */ (k.slice(2))] = v;
      i++;
    } else {
      process.stderr.write("usage: ci-watch.js [--sha <sha>] [--repo <owner/name>] [--cwd <dir>] | --hook\n");
      return EXIT.USAGE;
    }
  }
  /** @type {Target} */
  let t;
  try {
    const rb = repoOf(o);
    t = { ...rb, sha: fullSha(rb.repo, o.sha || rb.branch) };
  } catch (e) {
    process.stderr.write(`ci-watch: ${errMsg(e)}\n`);
    return EXIT.USAGE;
  }
  const r = watch(t);
  if (r.text) process.stderr.write(r.text + "\n");
  return r.code;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  process.exitCode = argv[0] === "--hook" ? hook() : cli(argv);
}

module.exports = { findPush, excerpt };
