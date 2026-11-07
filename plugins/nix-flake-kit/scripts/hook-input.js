/**
 * Shared input half of both PostToolUse hooks: read the hook JSON from stdin and
 * return the written .nix file, or null when the hook has nothing to do. One copy,
 * so the two hooks cannot drift on which files they act on.
 *
 * Returns { projectDir, dir, abs } with symlinks resolved, or null. Never throws.
 *
 * Containment is a PATH-SEGMENT test, not a string prefix: `startsWith(projectDir)`
 * accepted `/work/proj-other/x.nix` for project `/work/proj`. Both sides go through
 * realpath first, so `/tmp` vs `/private/tmp` (macOS) cannot fail a real match and a
 * symlinked directory pointing out of the project cannot pass a false one. Only the
 * DIRECTORY is resolved: a `.nix` that is itself a symlink is still staged as the link,
 * which is what git tracks.
 */

const fs = require("node:fs");
const path = require("node:path");

function within(root, p) {
  const rel = path.relative(root, p);
  // `..` as a whole first SEGMENT, so a dir named `..scratch` inside the project still counts.
  return rel === "" || (rel.split(path.sep)[0] !== ".." && !path.isAbsolute(rel));
}

function readNixTarget() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    return null;
  }
  if (!raw.trim()) return null;

  let evt;
  try {
    evt = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!evt || typeof evt !== "object") return null;

  const ti = evt.tool_input || {};
  // Write/Edit carry tool_input.file_path (always absolute, per the hooks reference);
  // tool_response.filePath is the same path, kept as a fallback.
  const file = ti.file_path || (evt.tool_response && evt.tool_response.filePath) || "";
  if (typeof file !== "string" || !file.endsWith(".nix")) return null;

  try {
    const projectDir = fs.realpathSync(process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const given = path.resolve(projectDir, file);
    const dir = fs.realpathSync(path.dirname(given));
    const abs = path.join(dir, path.basename(given));
    if (!within(projectDir, abs)) return null;
    return { projectDir, dir, abs };
  } catch {
    return null; // directory gone / unreadable
  }
}

module.exports = { readNixTarget, within };
