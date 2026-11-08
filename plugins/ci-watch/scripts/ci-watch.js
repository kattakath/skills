#!/usr/bin/env node
// @ts-check
/**
 * ci-watch: wait on every GitHub Actions run (or GitLab pipeline) that a commit pushed to
 * the default branch triggered. SILENT when they pass. In every other case (red, nothing checked it, still
 * running at the ceiling, or the watch itself failing) it writes a JSON report and prints
 * a short summary.
 *
 *   node ci-watch.js [--sha <sha>] [--repo <owner/name> | gitlab.com/<path>] [--cwd <dir>]
 *       CLI. The forge comes from --repo, else from the checkout's `origin` URL. Exit 0 green, 1 red, 3 no runs, 4 still running, 64 usage/lookup error.
 *   node ci-watch.js --hook
 *       PostToolUse(Bash) asyncRewake hook. Exit 0 on green or not-a-push-to-default.
 *       Anything else exits 2, which wakes the session with the summary (stderr).
 *
 * Everything comes from `gh` (GitHub), `glab` (GitLab, gitlab.com remotes) and `git`; there
 * is no model in this loop. Each forge is one adapter that returns runs and jobs in the
 * same shape, so the wait, the verdict and the report are shared. A GitLab pipeline is a
 * "run"; its jobs carry no steps, so `step` is null and the excerpt is cut by error line. The traps it is
 * built around are silent-instruments' §C:
 * - A short sha matches no runs (C10), so every sha is a full 40 chars.
 * - Zero runs, or runs that all skipped, is NOT green: something must have succeeded.
 * - Runs register late (a `workflow_run` chain starts when its parent ENDS), so "done"
 *   means every run completed AND the set has not changed for SETTLE_S.
 * - A commit can carry older runs from a PR or another branch; the hook counts only runs
 *   created since the push.
 * - `--log-failed` loses step attribution, so the failing step's lines come from the raw
 *   job log, cut by the step's own start/end timestamps.
 * - `glab api projects/<group%2Fname>/repository/…` answers 404 where the same path by
 *   numeric project id answers 200 (measured, glab 1.110.0), so the GitLab adapter resolves
 *   the id once and uses it for every later call.
 * - A GitLab job with `allow_failure: true` is a warning, not a cause; it is never reported.
 *
 * Tunables (env, seconds): CI_WATCH_APPEAR_S 180, CI_WATCH_SETTLE_S 90, CI_WATCH_POLL_S 20,
 * CI_WATCH_CEILING_S 2700 (clamped to 2700). Each gh/glab call times out at 30 s and a
 * report reads at most 5 failed jobs, so the worst case stays under hooks.json's 3600 s timeout
 * and the script reports STILL_RUNNING instead of being killed silently. CI_WATCH_DIR is
 * the report dir (default $CLAUDE_PLUGIN_DATA, else <tmp>/ci-watch). CI_WATCH_GH /
 * CI_WATCH_GLAB / CI_WATCH_GIT swap the binaries (tests).
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** @typedef {import('@anthropic-ai/claude-agent-sdk').PostToolUseHookInput} PostToolUseHookInput */
/** @typedef {"github" | "gitlab"} ForgeName */
/** @typedef {{ forge: ForgeName, repo: string, branch: string, host?: string, pid?: number }} RepoRef */
/** @typedef {RepoRef & { sha: string, since?: number }} Target */
/** @typedef {{ databaseId: number, workflowName: string, event: string, status: string, conclusion: string, url: string, createdAt: string }} Run */
/** @typedef {{ number: number, name: string, conclusion: string, startedAt?: string, completedAt?: string }} Step */
/** @typedef {{ databaseId: number, name: string, conclusion: string, url: string, steps: Step[] }} Job */
/** @typedef {{ n: number, text: string }} LogLine */
/** @typedef {{ ts: RegExp, isErr: (text: string) => boolean, clean: (text: string) => string }} LogFormat */
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
const GLAB = process.env.CI_WATCH_GLAB || "glab";
const GIT = process.env.CI_WATCH_GIT || "git";
/** @param {string[]} args @param {string} [cwd] @returns {any} */
const gh = (args, cwd) => JSON.parse(capture(GH, args, cwd));
/** @param {string} host @param {string} endpoint @returns {string} */
const glabRaw = (host, endpoint) => capture(GLAB, ["api", "--hostname", host, endpoint]);
/** @param {string} host @param {string} endpoint @returns {any} */
const glab = (host, endpoint) => JSON.parse(glabRaw(host, endpoint));
/** @param {string[]} args @param {string} cwd */
const git = (args, cwd) => capture(GIT, args, cwd).trim();

/**
 * The forge a remote URL points at, or null for anything else (which stays quiet). GitLab
 * is gitlab.com only: nothing here says which other hosts are GitLab, and guessing would
 * point glab at a host it has no login for.
 * @param {string} url
 * @returns {{ forge: "github" } | { forge: "gitlab", host: string, path: string } | null}
 */
function forgeOf(url) {
  if (/github\.com[:/]/.test(url)) return { forge: "github" };
  // scp form `git@gitlab.com:g/r.git`, or a URL `https://[user@]gitlab.com[:port]/g/r.git`.
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?(gitlab\.com)(?::\d+)?\/|(?:[^@/]+@)?(gitlab\.com):)(.+?)(?:\.git)?\/*$/.exec(url.trim());
  return m ? { forge: "gitlab", host: m[1] || m[2], path: m[3] } : null;
}

/** @param {string} s */
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const TS = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?(.*)$/;

/** GitLab's pipeline states that will not move on their own. `manual` waits on a human, so it wakes. */
const GL_DONE = new Set(["success", "failed", "canceled", "skipped", "manual"]);
/** @type {Record<"github" | "gitlab", LogFormat>} */
const LOG_FORMAT = {
  github: { ts: TS, isErr: (t) => t.includes("##[error]"), clean: (t) => stripAnsi(t) },
  // A GitLab trace line is `<ts> <stream><O|E>[ +]<text>`. Section markers carry a bare
  // `\r` mid-line, which `.` does not match, hence `[^]` in the timestamp split.
  gitlab: {
    ts: /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?([^]*)$/,
    isErr: (t) => /^ERROR: /.test(t),
    clean: (t) => stripAnsi(t.replace(/^\d\d[OE][ +]/, "").replace(/section_(?:start|end):\d+:[^\r\n]*?\r/g, "")),
  },
};

/**
 * One adapter per forge. Each returns runs and jobs in the GitHub shape (`Run`, `Job`), so
 * waiting, the verdict, the report and the summary are forge-blind.
 */
const FORGES = {
  github: {
    /** @param {{ cwd?: string, repo?: string }} o @returns {RepoRef} */
    repoOf(o) {
      const view = gh(["repo", "view", ...(o.repo ? [o.repo] : []), "--json", "nameWithOwner,defaultBranchRef"], o.cwd);
      return { forge: "github", repo: String(view.nameWithOwner), branch: String(view.defaultBranchRef && view.defaultBranchRef.name) };
    },
    /** @param {RepoRef} t @param {string} ref @returns {string} */
    sha: (t, ref) => String(gh(["api", `repos/${t.repo}/commits/${ref}`]).sha),
    /** @param {Target} t @returns {Run[]} */
    runs: (t) => gh(["run", "list", "--repo", t.repo, "--commit", t.sha, "--limit", "100", "--json", "databaseId,workflowName,event,status,conclusion,url,createdAt"]),
    /** @param {Target} t @param {Run} run @returns {Job[]} */
    jobs: (t, run) => gh(["run", "view", String(run.databaseId), "--repo", t.repo, "--json", "jobs"]).jobs || [],
    /** @param {Target} t @param {number} id */
    log: (t, id) => capture(GH, ["api", `repos/${t.repo}/actions/jobs/${id}/logs`, "--allow-escape-sequences"]),
    /** @param {Target} t @returns {{ subject: string, files: string[] }} */
    commit(t) {
      const c = gh(["api", `repos/${t.repo}/commits/${t.sha}`]);
      return { subject: String(c.commit && c.commit.message).split("\n")[0], files: (c.files || []).map((/** @type {{ filename: string }} */ f) => f.filename) };
    },
    /** @param {Target} t */
    commitUrl: (t) => `https://github.com/${t.repo}/commit/${t.sha}`,
    /** True when `sha` is the tip of the branch or behind it (so it is ON the branch). @param {Target} t */
    onBranch(t) {
      const st = String(gh(["api", `repos/${t.repo}/compare/${t.sha}...${t.branch}`]).status);
      return st === "identical" || st === "ahead";
    },
    /** @param {Target} t @param {Run} run @param {Job | null} _job */
    commands: (t, run, _job) => ({ view: `gh run view ${run.databaseId} --repo ${t.repo}`, rerun: `gh run rerun ${run.databaseId} --repo ${t.repo} --failed` }),
    viewSuffix: " --log-failed",
  },
  gitlab: {
    /** @param {{ host: string, path: string }} o @returns {RepoRef} */
    repoOf(o) {
      const p = glab(o.host, `projects/${encodeURIComponent(o.path)}`);
      return { forge: "gitlab", repo: String(p.path_with_namespace), branch: String(p.default_branch), host: o.host, pid: Number(p.id) };
    },
    /** @param {RepoRef} t @param {string} ref @returns {string} */
    sha: (t, ref) => String(glab(String(t.host), `projects/${t.pid}/repository/commits/${encodeURIComponent(ref)}`).id),
    /** @param {Target} t @returns {Run[]} */
    runs: (t) =>
      glab(String(t.host), `projects/${t.pid}/pipelines?sha=${t.sha}&per_page=100`).map(
        (/** @type {{ id: number, name?: string | null, source: string, status: string, web_url: string, created_at: string }} */ p) => ({
          databaseId: p.id,
          workflowName: p.name || `pipeline ${p.id}`,
          event: p.source,
          status: GL_DONE.has(p.status) ? "completed" : p.status,
          conclusion: GL_DONE.has(p.status) ? p.status : "",
          url: p.web_url,
          createdAt: p.created_at,
        }),
      ),
    /** Only the jobs that are a cause: failed or canceled, and not allowed to fail. @param {Target} t @param {Run} run @returns {Job[]} */
    jobs: (t, run) =>
      glab(String(t.host), `projects/${t.pid}/pipelines/${run.databaseId}/jobs?per_page=100`)
        .filter((/** @type {{ status: string, allow_failure?: boolean }} */ j) => (j.status === "failed" || j.status === "canceled") && !j.allow_failure)
        .map((/** @type {{ id: number, name: string, status: string, web_url: string }} */ j) => ({ databaseId: j.id, name: j.name, conclusion: j.status, url: j.web_url, steps: [] })),
    /** @param {Target} t @param {number} id */
    log: (t, id) => glabRaw(String(t.host), `projects/${t.pid}/jobs/${id}/trace`),
    /** @param {Target} t @returns {{ subject: string, files: string[] }} */
    commit(t) {
      const c = glab(String(t.host), `projects/${t.pid}/repository/commits/${t.sha}`);
      const diff = glab(String(t.host), `projects/${t.pid}/repository/commits/${t.sha}/diff?per_page=100`);
      return { subject: String(c.title), files: diff.map((/** @type {{ new_path: string }} */ d) => d.new_path) };
    },
    /** @param {Target} t */
    commitUrl: (t) => `https://${t.host}/${t.repo}/-/commit/${t.sha}`,
    /** The sha is ON the branch when it is its own merge base with the branch tip (no ref list to paginate). @param {Target} t */
    onBranch: (t) => String(glab(String(t.host), `projects/${t.pid}/repository/merge_base?refs[]=${t.sha}&refs[]=${encodeURIComponent(t.branch)}`).id) === t.sha,
    /** @param {Target} t @param {Run} run @param {Job | null} job */
    commands: (t, run, job) =>
      job
        ? { view: `glab ci trace ${job.databaseId} -R ${t.repo}`, rerun: `glab ci retry ${job.databaseId} -R ${t.repo}` }
        : { view: `glab ci get -p ${run.databaseId} -R ${t.repo}`, rerun: `glab api -X POST projects/${t.pid}/pipelines/${run.databaseId}/retry` },
    viewSuffix: "",
  },
};

/** Expand any ref or short sha to the full sha through the API. @param {RepoRef} t @param {string} ref */
function fullSha(t, ref) {
  const sha = FORGES[t.forge].sha(t, ref);
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
  const t0 = Date.now();
  let lastChange = t0;
  let key = "";
  /** @type {Run[]} */
  let runs = [];
  for (;;) {
    /** @type {Run[]} */
    const seen = FORGES[t.forge].runs(t);
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

/**
 * The failing step's lines from a raw job log, with real 1-based line numbers.
 * The step's [startedAt, completedAt] window cuts the log. Inside it the excerpt runs
 * from 30 lines before the first `##[error]` through the last one; without a window (no
 * timestamps) it falls back to the whole log. Over 60 lines, the FIRST error keeps its
 * run-up (usually the root cause) and the tail keeps the last errors.
 * @param {string} raw @param {Step | null} step @param {LogFormat} [fmt] error marker + line cleaner, GitHub's by default
 * @returns {{ total_lines: number, error_lines: number[], lines: LogLine[] }}
 */
function excerpt(raw, step, fmt = LOG_FORMAT.github) {
  const all = raw.split(/\r?\n/).map((l, i) => {
    const m = fmt.ts.exec(l);
    return { n: i + 1, ts: m ? Date.parse(m[1]) : NaN, text: fmt.clean(m ? m[2] : l) };
  });
  const from = step && step.startedAt ? Date.parse(step.startedAt) : NaN;
  const to = step && step.completedAt ? Date.parse(step.completedAt) + 1000 : NaN;
  let pool = all.filter((l) => !Number.isNaN(from) && l.ts >= from && (Number.isNaN(to) || l.ts <= to));
  if (pool.length === 0) pool = all;
  const errs = pool.filter((l) => fmt.isErr(l.text));
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
    commands: FORGES[t.forge].commands(t, run, null),
  };
  /** @type {Job[]} */
  let jobs;
  try {
    jobs = FORGES[t.forge].jobs(t, run);
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
      commands: FORGES[t.forge].commands(t, run, j),
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
    const c = FORGES[t.forge].commit(t);
    subject = c.subject;
    files = c.files.slice(0, 100);
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
      f.log = excerpt(FORGES[t.forge].log(t, f.job_id), step, LOG_FORMAT[t.forge]);
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
    commit_url: FORGES[t.forge].commitUrl(t),
    changed_files: files,
    started_at: startedAt,
    finished_at: now(),
    note,
    runs: runs.map((r) => ({ id: r.databaseId, workflow: r.workflowName, event: r.event, status: r.status, conclusion: r.conclusion, url: r.url })),
    failures: found.map((x) => x.f),
    pending: runs.filter((r) => r.status !== "completed").map((r) => r.workflowName),
  };
}

/** @param {Report} r @param {string} file @param {ForgeName} forge */
function summary(r, file, forge) {
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
    out.push(`    ${f.commands.view}${FORGES[forge].viewSuffix}   |   ${f.commands.rerun}`);
  }
  out.push(`Full report (job/step ids, numbered log lines, changed files): ${file}`);
  return out.join("\n");
}

/** @param {Report} r @returns {string} */
function save(r) {
  const dir = reportDir();
  fs.mkdirSync(dir, { recursive: true });
  // Every slash: a GitLab subgroup path (g/sub/r) would otherwise name a missing directory.
  const file = path.join(dir, `${r.repo.replace(/\//g, "--")}-${r.sha}.json`);
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
  return { code: EXIT[status], text: summary(r, save(r), t.forge) };
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

  // Quiet ONLY when there is nothing to watch: not a git checkout, a remote that is neither
  // GitHub nor gitlab.com, or a checkout with no branch. "Could not look it up" is a
  // different thing and wakes below.
  if (!fs.existsSync(push.dir)) {
    process.stderr.write(`ci-watch WATCH_FAILED: a push ran in ${push.dir}, which does not exist here (a shell variable?). Watch it by hand with --sha.\n`);
    return 2;
  }
  /** @type {{ src: string, dst: string }} */
  let spec;
  let pushed;
  /** @type {ReturnType<typeof forgeOf>} */
  let fg;
  try {
    if (git(["rev-parse", "--is-inside-work-tree"], push.dir) !== "true") return 0;
    const remote = push.args.filter((a) => !a.startsWith("-"))[0] || "origin";
    const url = /[:/]/.test(remote) ? remote : git(["config", "--get", `remote.${remote}.url`], push.dir);
    fg = forgeOf(url);
    if (!fg) return 0;
    spec = refspecOf(push.args, push.dir);
    pushed = git(["rev-parse", `${spec.src}^{commit}`], push.dir);
  } catch {
    return 0;
  }
  // From here a GitHub or GitLab push happened, so every failure must wake the session.
  const label = `${push.dir}@${String(pushed).slice(0, 12)}`;
  try {
    const rb = fg.forge === "gitlab" ? FORGES.gitlab.repoOf(fg) : FORGES.github.repoOf({ cwd: push.dir });
    if (spec.dst !== rb.branch) return 0; // a feature-branch push
    const t = { ...rb, sha: fullSha(rb, pushed), since: hookStart - 120_000 };
    if (!FORGES[t.forge].onBranch(t)) return 0; // the push did not land (rejected, or rewritten)
    // One watcher per sha: exclusive create, so a second hook for the same push exits here.
    try {
      fs.mkdirSync(reportDir(), { recursive: true });
      fs.closeSync(fs.openSync(path.join(reportDir(), `watched-${t.repo.replace(/\//g, "--")}-${t.sha}`), "wx"));
    } catch (e) {
      if (/** @type {{ code?: string }} */ (e).code === "EEXIST") return 0;
      // An unwritable dir only costs the dedupe; the watch still runs.
    }
    const r = watch(t);
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
      process.stderr.write("usage: ci-watch.js [--sha <sha>] [--repo <owner/name> | gitlab.com/<path>] [--cwd <dir>] | --hook\n");
      return EXIT.USAGE;
    }
  }
  /** @type {Target} */
  let t;
  try {
    // --repo names the forge when it is a gitlab.com path or URL; without it, `origin` does.
    let url = o.repo ? (/^gitlab\.com\//.test(o.repo) ? `https://${o.repo}` : o.repo) : "";
    if (!o.repo) {
      try {
        url = git(["config", "--get", "remote.origin.url"], o.cwd || process.cwd());
      } catch {
        // No checkout or no origin: gh resolves the repo (or says why it cannot).
      }
    }
    const fg = forgeOf(url);
    const rb = fg && fg.forge === "gitlab" ? FORGES.gitlab.repoOf(fg) : FORGES.github.repoOf(o);
    t = { ...rb, sha: fullSha(rb, o.sha || rb.branch) };
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

module.exports = { findPush, excerpt, forgeOf };
