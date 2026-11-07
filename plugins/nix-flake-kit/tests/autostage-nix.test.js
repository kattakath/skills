// Cases for scripts/autostage-nix.js — the git-purity safety net. Each case builds a
// throwaway git repo, writes a file, runs the hook the way Claude Code does (hook JSON
// on stdin, CLAUDE_PROJECT_DIR in the env), then asks GIT what it tracks. The hook
// always exits 0, so the index, not the exit code, is the evidence.
//
// Run:  node --test plugins/nix-flake-kit/tests/autostage-nix.test.js
//
// Both halves: must-STAGE (including the nested-worktree case that was silently
// missed) and must-NOT-touch (outside the project, a prefix-sibling directory, a
// symlink out of the project, non-.nix), plus the shell-injection regression.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");

const HOOK = path.join(__dirname, "..", "scripts", "autostage-nix.js");
// realpath: on macOS os.tmpdir() is under /var, a symlink to /private/var.
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "autostage-nix-")));
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
  });

function repo(name) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

function run(file, projectDir, extra = {}) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: extra.raw ?? JSON.stringify({ tool_name: "Write", tool_input: { file_path: file } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, `hook must exit 0; stderr: ${res.stderr}`);
  assert.equal(res.stderr, "");
  return res.stdout;
}

const tracked = (cwd, rel) => git(cwd, "ls-files", "--", rel).trim() !== "";

test("STAGES a new .nix inside the project", () => {
  const p = repo("plain");
  fs.writeFileSync(path.join(p, "a.nix"), "1\n");
  const out = run(path.join(p, "a.nix"), p);
  assert.ok(tracked(p, "a.nix"));
  assert.match(JSON.parse(out).systemMessage, /auto-staged a\.nix/);
});

test("STAGES a .nix in a subdirectory", () => {
  const p = repo("subdir");
  fs.mkdirSync(path.join(p, "modules/x"), { recursive: true });
  fs.writeFileSync(path.join(p, "modules/x/b.nix"), "1\n");
  run(path.join(p, "modules/x/b.nix"), p);
  assert.ok(tracked(p, "modules/x/b.nix"));
});

// Claude Code's own worktree location is INSIDE the project, and CLAUDE_PROJECT_DIR
// stays at the main checkout (code.claude.com/docs/en/worktrees). Before the fix the
// main repo was asked to add a path inside the nested worktree, refused, and the hook
// said nothing.
test("STAGES a .nix in a .claude/worktrees/<name> worktree, in THAT worktree's index", () => {
  const p = repo("wt-main");
  git(p, "worktree", "add", "-q", ".claude/worktrees/w");
  const w = path.join(p, ".claude/worktrees/w");
  fs.writeFileSync(path.join(w, "c.nix"), "1\n");
  run(path.join(w, "c.nix"), p);
  assert.ok(tracked(w, "c.nix"), "must be tracked in the worktree");
  assert.equal(git(p, "ls-files").trim(), "", "main checkout index must be untouched");
});

test("STAGES a .nix in a nested repo, in the nested repo", () => {
  const p = repo("outer");
  const inner = path.join(p, "inner");
  fs.mkdirSync(inner);
  git(inner, "init", "-q");
  fs.writeFileSync(path.join(inner, "flake.nix"), "{ outputs = _: { }; }\n");
  run(path.join(inner, "flake.nix"), p);
  assert.ok(tracked(inner, "flake.nix"));
});

// Shell-injection regression: the old execSync put the path inside shell double
// quotes, where $(…) still expands. Measured 2026-11-07: this created PWNED.
test("NO SHELL: a $(…) filename is staged literally and runs nothing", () => {
  const p = repo("inject");
  const name = "$(touch PWNED)`touch PWNED2`.nix";
  fs.writeFileSync(path.join(p, name), "1\n");
  run(path.join(p, name), p);
  assert.ok(!fs.existsSync(path.join(p, "PWNED")), "command substitution ran");
  assert.ok(!fs.existsSync(path.join(p, "PWNED2")), "backtick substitution ran");
  assert.ok(tracked(p, name));
});

test("STAGES a .nix under a directory whose NAME starts with two dots", () => {
  const p = repo("dotdot");
  fs.mkdirSync(path.join(p, "..scratch"));
  fs.writeFileSync(path.join(p, "..scratch", "i.nix"), "1\n");
  run(path.join(p, "..scratch", "i.nix"), p);
  assert.ok(tracked(p, "..scratch/i.nix"));
});

test("NO OPTION: a filename starting with - is a pathspec, not a flag", () => {
  const p = repo("dash");
  fs.writeFileSync(path.join(p, "-n.nix"), "1\n");
  run(path.join(p, "-n.nix"), p);
  assert.ok(tracked(p, "-n.nix"));
});

test("SKIPS a .nix outside the project (sibling repo)", () => {
  const p = repo("proj");
  const s = repo("elsewhere");
  fs.writeFileSync(path.join(s, "d.nix"), "1\n");
  assert.equal(run(path.join(s, "d.nix"), p), "");
  assert.ok(!tracked(s, "d.nix"));
});

// `startsWith(projectDir)` accepted /base/proj-sib for /base/proj.
test("SKIPS a prefix-sibling directory (proj vs proj-sib)", () => {
  const p = repo("pfx");
  const s = repo("pfx-sib");
  fs.writeFileSync(path.join(s, "e.nix"), "1\n");
  assert.equal(run(path.join(s, "e.nix"), p), "");
  assert.ok(!tracked(s, "e.nix"));
});

test("SKIPS a .nix reached through a symlinked dir that leaves the project", () => {
  const p = repo("symproj");
  const s = repo("symtarget");
  fs.symlinkSync(s, path.join(p, "link"));
  fs.writeFileSync(path.join(s, "f.nix"), "1\n");
  assert.equal(run(path.join(p, "link", "f.nix"), p), "");
  assert.ok(!tracked(s, "f.nix"));
});

test("SKIPS a non-.nix file", () => {
  const p = repo("nonnix");
  fs.writeFileSync(path.join(p, "README.md"), "x\n");
  assert.equal(run(path.join(p, "README.md"), p), "");
  assert.ok(!tracked(p, "README.md"));
});

test("QUIET for a gitignored .nix (deliberate, not forced)", () => {
  const p = repo("ignored");
  fs.writeFileSync(path.join(p, ".gitignore"), "secret.nix\n");
  fs.writeFileSync(path.join(p, "secret.nix"), "1\n");
  assert.equal(run(path.join(p, "secret.nix"), p), "");
  assert.ok(!tracked(p, "secret.nix"));
});

test("QUIET outside any git repository", () => {
  const d = path.join(base, "norepo");
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, "g.nix"), "1\n");
  // GIT_CEILING_DIRECTORIES stops discovery at base, in case tmp sits inside a repo.
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(d, "g.nix") } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: d, GIT_CEILING_DIRECTORIES: base },
    encoding: "utf8",
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
  assert.equal(res.stderr, "");
});

// A failed stage must never be silent: Claude is told, via additionalContext.
test("TELLS Claude when git add fails (index.lock held)", () => {
  const p = repo("locked");
  fs.writeFileSync(path.join(p, ".git", "index.lock"), "");
  fs.writeFileSync(path.join(p, "h.nix"), "1\n");
  const out = run(path.join(p, "h.nix"), p);
  const h = JSON.parse(out).hookSpecificOutput;
  assert.equal(h.hookEventName, "PostToolUse");
  assert.match(h.additionalContext, /could NOT auto-stage h\.nix/);
  fs.unlinkSync(path.join(p, ".git", "index.lock"));
});

test("QUIET on garbage stdin, empty stdin, and a JSON non-object", () => {
  const p = repo("garbage");
  for (const raw of ["{not json", "", "null", "42"]) assert.equal(run("", p, { raw }), "");
});
