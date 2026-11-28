// edit-habit through its real hook entry (stdin JSON in, stdout out), case table.
// Advice means stdout JSON with additionalContext and NO permissionDecision; quiet means no output.
// Prints "edit-habit: <pass> passed, <fail> failed"; exit 0 only when all pass.
"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const HOOK = process.env.EDIT_HABIT || path.join(__dirname, "..", "scripts", "edit-habit.js");

/** [label, command, expect advice] */
const CASES = [
  // advised: editing an existing file in place
  ["sed -i on a repo file", "sed -i '' 's/1.0.7/1.0.8/' plugins/x/.claude-plugin/plugin.json", true],
  ["GNU sed -i without a suffix", "sed -i 's/foo/bar/' src/app.ts", true],
  ["sed --in-place", "sed --in-place 's/a/b/' README.md", true],
  ["sed -Ei combined flags", "sed -Ei 's/(x)/y/' lib/a.sh", true],
  ["sed -i after cd and &&", "cd repo && sed -i '' '/old/d' docs/guide.md && git add -A", true],
  ["perl -pi -e", "perl -pi -e 's/foo/bar/g' config.yml", true],
  ["python heredoc read_text + write_text", "python3 - <<'PY'\nimport pathlib\np = pathlib.Path('docs/a.md'); s = p.read_text()\np.write_text(s.replace('a', 'b'))\nPY", true],
  ["python heredoc open().read + open(w).write", "python3 - <<'EOF'\np='routines/x.md'; s=open(p).read()\nopen(p,'w').write(s.replace('x','y'))\nEOF", true],
  ["python -c read-modify-write", "python3 -I -c \"p='index.html';s=open(p).read();open(p,'w').write(s.replace('a','b'))\"", true],
  ["python json load + dump back", "python3 - <<'PY'\nimport json\nm=json.load(open('.mcp.json'))\nm['x']=1\nopen('.mcp.json','w').write(json.dumps(m))\nPY", true],
  ["sed -i on a variable target", 'for f in $(git ls-files "*.md"); do sed -i "" "s/x/y/" "$f"; done', true],
  // quiet
  ["sed without -i (stream)", "sed -n '1,20p' README.md", false],
  ["sed -i on a /tmp file", "sed -i '' 's/a/b/' /tmp/scratch.txt", false],
  ["sed -i on a scratchpad file", "sed -i '' 's/a/b/' /private/tmp/claude-501/x/scratchpad/notes.md", false],
  ["sed -i on $S/ scratch", 'sed -i "" "s/a/b/" "$S/w.sh"', false],
  ["python script file run by path (reads files)", 'python3 -I "$S/x.py" data/in.json', false],
  ["python heredoc writing a NEW file only", "python3 - <<'PY'\nopen('out/report.json','w').write('{}')\nPY", false],
  ["python heredoc that only reads", "python3 - <<'PY'\nimport json\nprint(len(json.load(open('a.json'))))\nPY", false],
  ["heredoc writing a new scratch file", "cat > \"$S/x.py\" <<'EOF'\nprint('hi')\nEOF", false],
  ["python read-modify-write on a /tmp file only", "python3 - <<'PY'\np='/tmp/a.txt'; s=open(p).read(); open(p,'w').write(s+'x')\nPY", false],
  ["git commit message mentioning sed -i", 'git commit -m "docs: stop using sed for edits"', false],
  ["grep for sed -i", "grep -rn 'sed -i' plugins/", false],
];

let pass = 0;
let fail = 0;
for (const [label, command, want] of CASES) {
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
  const r = spawnSync("node", [HOOK], { input, encoding: "utf8" });
  let advice = false;
  let decided = false;
  if (r.stdout.trim()) {
    try {
      const h = JSON.parse(r.stdout).hookSpecificOutput;
      advice = typeof h.additionalContext === "string" && h.additionalContext.length > 0;
      decided = "permissionDecision" in h;
    } catch {
      advice = false;
    }
  }
  const ok = r.status === 0 && advice === want && !decided && (want || r.stdout === "");
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL edit-habit: ${label}: exit ${r.status}, advice ${advice}, decision ${decided}, want ${want}`);
  }
}
const g = spawnSync("node", [HOOK], { input: "not json", encoding: "utf8" });
if (g.status === 0 && g.stdout === "" && g.stderr === "") pass++;
else {
  fail++;
  console.log(`FAIL edit-habit: garbage input: exit ${g.status}, stdout '${g.stdout}'`);
}
console.log(`edit-habit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
