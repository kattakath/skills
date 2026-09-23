// Fixture suite for scripts/nix-home-path-lint.js — the hook half of
// nix-config's ast-grep/rules/nix-hardcoded-home-path.yml. Every fixture below
// mirrors one in that rule's rule-tests file (valid ⇢ exit 0, invalid ⇢ exit 2)
// so the two halves are proven against the SAME inputs; the extra cases at the
// end pin the line-based behaviours the rule has no equivalent of.
//
// Run:  node --test plugins/claude-code-nix/tests/nix-home-path-lint.test.js
//
// Both halves are asserted — must-FLAG and must-stay-QUIET — and so is "never
// throws", because an uncaught error exits 0 and silently disarms the lint.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HOOK = path.join(__dirname, "..", "scripts", "nix-home-path-lint.js");
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "nix-home-path-lint-"));
let n = 0;

// Write `content` as a .nix file under a fake project dir and run the hook the
// way Claude Code does: hook JSON on stdin, CLAUDE_PROJECT_DIR in the env.
function lint(content, { name = `case-${++n}.nix`, write = true } = {}) {
  const file = path.join(projectDir, name);
  if (write) fs.writeFileSync(file, content);
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: file } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    encoding: "utf8",
  });
  return { code: res.status, err: res.stderr, out: res.stdout };
}

const flags = (label, content) =>
  test(`FLAGS  ${label}`, () => {
    const r = lint(content);
    assert.equal(r.code, 2, `expected exit 2, got ${r.code}; stderr: ${r.err}`);
    assert.match(r.err, /Hardcoded per-user home path/);
  });

const quiet = (label, content) =>
  test(`QUIET  ${label}`, () => {
    const r = lint(content);
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}; stderr: ${r.err}`);
    assert.equal(r.err, "");
  });

// ---- invalid (rule-tests `invalid:`) --------------------------------------
// THE TRAILING-SLASH GAP (2026-09-16): a path ending AT the home dir.
flags("path ending at the home dir, Linux", '{ dir = "/home/izzy"; }');
flags("path ending at the home dir, macOS", '{ stateDir = "/Users/ismail"; }');
flags("home dir followed by a space", '{ cmd = "ls /Users/ismail -la"; }');
flags("home dir with a subpath", '{ dir = "/Users/ismail/Developer/x"; }');
flags("dotfile under a Linux home", '{ dir = "/home/ismail/.config/foo"; }');
flags("inside an indented string", "{ script = ''\n  cd /Users/ismail/repo\n''; }");
// A `home.*` attrpath that does not END in `home` is a value, not a declaration.
flags("home.file source is not a home declaration", '{ home.file."x".source = "/Users/ismail/x"; }');
// Regression: an exempt path on the same line used to hide a real one.
flags("exempt and real home on one line", '{ a = "/Users/admin/x"; b = "/Users/ismail/y"; }');
// Two strings in one `home` binding: only the DIRECT value is a declaration.
flags("second string on a home line is not the declaration", '{ home = "/Users/izzy"; x = "/Users/izzy"; }');
// The declaration split across lines is a known false positive of the approximation.
flags("multi-line declaration (documented false positive)", '{\n  users.users.izzy.home =\n    "/Users/izzy";\n}');

// ---- valid (rule-tests `valid:`) ------------------------------------------
quiet("Tart guest account admin", '{ runnerDirInGuest = "/Users/admin/actions-runner"; }');
quiet("evalModules fixture tester", '{ stateDir = "/Users/tester/.local/state/tart-runner"; }');
quiet("option-example placeholder me", '{ example = [ "Downloads:/Users/me/Downloads" ]; }');
quiet("composition-API fixture stranger, ending at the home dir", '{ x = "/Users/stranger"; }');
quiet("uppercase segment is not a user", '{ dir = "/Users/Shared/x"; }');
quiet("shell variable is not a user", '{ dir = "/Users/$USER/x"; }');
quiet("interpolated homeDirectory", '{ dir = "${config.home.homeDirectory}/x"; }');
quiet("bare /home with no user", '{ dir = "/home"; }');
quiet("prose in a comment", '# see /Users/ismail/Developer for the layout\n{ }');
// STRUCTURAL exemption — the declaration of a home dir, both spellings.
quiet("users.users.<name>.home declaration", '{ users.users.izzy.home = "/Users/izzy"; }');
quiet("bare home = inside a users.users.<name> attrset", '{\n  users.users.izzy = {\n    home = "/Users/izzy";\n  };\n}');
quiet("one-line attrset, as nix-config checks.nix spells it", '{ users.users.stranger.home = "/Users/stranger"; }');
quiet("one-line nested attrset", 'users.users.izzy = { home = "/Users/izzy"; };');

// ---- protocol -------------------------------------------------------------
test("QUIET  non-.nix file is ignored", () => {
  const r = lint('x = "/Users/ismail"', { name: "notes.md" });
  assert.equal(r.code, 0);
});
test("QUIET  unreadable file never throws", () => {
  const r = lint("", { name: "gone.nix", write: false });
  assert.equal(r.code, 0);
  assert.equal(r.err, "");
});
test("QUIET  garbage stdin never throws", () => {
  const res = spawnSync(process.execPath, [HOOK], { input: "{not json", encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.equal(res.stderr, "");
});
test("FLAGS  reports file:line for each hit", () => {
  const r = lint('{\n  a = "/Users/ismail";\n  b = "/Users/admin/x";\n  c = "/home/izzy/y";\n}');
  assert.equal(r.code, 2);
  assert.match(r.err, /case-\d+\.nix:2: a = "\/Users\/ismail";/);
  assert.match(r.err, /case-\d+\.nix:4: c = "\/home\/izzy\/y";/);
  assert.doesNotMatch(r.err, /:3:/);
});
