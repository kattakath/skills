#!/usr/bin/env node
// @ts-check
// Fixture-driven stand-in for `gh`, `glab` and `git`. Every call is appended to
// $CI_WATCH_FIXTURE/calls.log as `<args> @<cwd>`; responses are files in that directory:
//   repo view                 -> repo.json
//   api …/commits/<ref>       -> commit-<ref>.json, else commit.json
//   api …/compare/<a>...<b>   -> compare.json, else {"status":"identical"}
//   run list (call k)         -> run-list.<k>.json, clamped to the highest k that exists
//   run view <id>             -> run-view-<id>.json
//   api …/jobs/<id>/logs      -> job-<id>.log (missing = HTTP 404, exit 1)
//   git rev-parse <rev>       -> $CI_WATCH_FAKE_HEAD (unset = exit 128)
//   git symbolic-ref …        -> $CI_WATCH_FAKE_BRANCH (default main)
//   git rev-parse --is-inside-work-tree -> true, unless $CI_WATCH_FAKE_NOTREPO
//   git config --get remote.<r>.url     -> $CI_WATCH_FAKE_REMOTE (default a github.com url)
// glab (`api --hostname <h> <endpoint>`; the project is id 42 once resolved):
//   projects/<url-encoded path>            -> gl-project.json
//   projects/42/pipelines?sha=… (call k)   -> gl-pipelines.<k>.json, clamped like run list
//   projects/42/pipelines/<id>/jobs?…      -> gl-jobs-<id>.json
//   projects/42/jobs/<id>/trace            -> gl-trace-<id>.log
//   projects/42/repository/commits/<ref>   -> gl-commit-<ref>.json, else gl-commit.json
//   …/commits/<sha>/diff?…                 -> gl-diff.json, else []
//   …/repository/merge_base?refs[]=<a>&…   -> gl-merge-base.json, else {"id":"<a>"} (on the branch)
const fs = require("node:fs");
const path = require("node:path");

const dir = process.env.CI_WATCH_FIXTURE || "";
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), `${args.join(" ")} @${process.cwd()}\n`);

/** @param {string} f */
const send = (f) => {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) {
    process.stderr.write(`gh: HTTP 404: Not Found (${f})\n`);
    process.exit(1);
  }
  process.stdout.write(fs.readFileSync(p, "utf8"));
  process.exit(0);
};

if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
  if (process.env.CI_WATCH_FAKE_NOTREPO) process.exit(128);
  process.stdout.write("true\n");
  process.exit(0);
}
if (args[0] === "config") {
  process.stdout.write((process.env.CI_WATCH_FAKE_REMOTE || "git@github.com:o/r.git") + "\n");
  process.exit(0);
}
if (args[0] === "rev-parse") {
  if (!process.env.CI_WATCH_FAKE_HEAD) process.exit(128);
  process.stdout.write(process.env.CI_WATCH_FAKE_HEAD + "\n");
  process.exit(0);
}
if (args[0] === "symbolic-ref") {
  process.stdout.write((process.env.CI_WATCH_FAKE_BRANCH || "main") + "\n");
  process.exit(0);
}
/** @param {string} prefix */
const counted = (prefix) => {
  const counter = path.join(dir, `.${prefix}-count`);
  const k = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
  fs.writeFileSync(counter, String(k));
  let i = k;
  while (i > 1 && !fs.existsSync(path.join(dir, `${prefix}.${i}.json`))) i--;
  send(`${prefix}.${i}.json`);
};
if (args[0] === "api" && args[1] === "--hostname") {
  const ep = args[3] || "";
  if (/^projects\/[^/?]*%2F[^/?]*$/.test(ep)) send("gl-project.json");
  if (/^projects\/42\/pipelines\?sha=/.test(ep)) counted("gl-pipelines");
  const jobs = /^projects\/42\/pipelines\/(\d+)\/jobs/.exec(ep);
  if (jobs) send(`gl-jobs-${jobs[1]}.json`);
  const trace = /^projects\/42\/jobs\/(\d+)\/trace$/.exec(ep);
  if (trace) send(`gl-trace-${trace[1]}.log`);
  const mb = /^projects\/42\/repository\/merge_base\?refs\[\]=([^&]+)/.exec(ep);
  if (mb) {
    if (fs.existsSync(path.join(dir, "gl-merge-base.json"))) send("gl-merge-base.json");
    process.stdout.write(JSON.stringify({ id: mb[1] }));
    process.exit(0);
  }
  if (/^projects\/42\/repository\/commits\/[^/]+\/diff/.test(ep)) {
    if (fs.existsSync(path.join(dir, "gl-diff.json"))) send("gl-diff.json");
    process.stdout.write("[]");
    process.exit(0);
  }
  const gc = /^projects\/42\/repository\/commits\/([^/?]+)$/.exec(ep);
  if (gc) send(fs.existsSync(path.join(dir, `gl-commit-${gc[1]}.json`)) ? `gl-commit-${gc[1]}.json` : "gl-commit.json");
}
if (args[0] === "repo" && args[1] === "view") send("repo.json");
if (args[0] === "run" && args[1] === "list") counted("run-list");
if (args[0] === "run" && args[1] === "view") send(`run-view-${args[2]}.json`);
if (args[0] === "api") {
  const logs = /actions\/jobs\/(\d+)\/logs$/.exec(args[1]);
  if (logs) send(`job-${logs[1]}.log`);
  if (/\/compare\//.test(args[1])) {
    if (fs.existsSync(path.join(dir, "compare.json"))) send("compare.json");
    process.stdout.write('{"status":"identical"}');
    process.exit(0);
  }
  const c = /commits\/([^/]+)$/.exec(args[1]);
  if (c) send(fs.existsSync(path.join(dir, `commit-${c[1]}.json`)) ? `commit-${c[1]}.json` : "commit.json");
}
process.stderr.write(`gh-stub: unhandled: ${args.join(" ")}\n`);
process.exit(2);
