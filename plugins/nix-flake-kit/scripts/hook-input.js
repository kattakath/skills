// @ts-check
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

// Types only — erased at run time, so the hook still needs nothing but `node`. They come
// from Anthropic's own SDK (CI installs it as a dev dependency and runs tsc over this file).
/** @typedef {import('@anthropic-ai/claude-agent-sdk').PostToolUseHookInput} PostToolUseHookInput */
/** @typedef {{ projectDir: string, dir: string, abs: string }} NixTarget */

/**
 * @param {string} root
 * @param {string} p
 * @returns {boolean}
 */
function within(root, p) {
  const rel = path.relative(root, p);
  // `..` as a whole first SEGMENT, so a dir named `..scratch` inside the project still counts.
  return rel === "" || (rel.split(path.sep)[0] !== ".." && !path.isAbsolute(rel));
}

/** @returns {NixTarget | null} */
function readNixTarget() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    return null;
  }
  if (!raw.trim()) return null;

  /** @type {PostToolUseHookInput} */
  let evt;
  try {
    evt = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!evt || typeof evt !== "object") return null;

  // The SDK types tool_input / tool_response as `unknown` (they differ per tool). For
  // Write/Edit both are objects; the `typeof` test below rejects anything else.
  const ti = /** @type {{ file_path?: unknown }} */ (evt.tool_input || {});
  const tr = /** @type {{ filePath?: unknown } | undefined} */ (evt.tool_response);
  // Write/Edit carry tool_input.file_path (always absolute, per the hooks reference);
  // tool_response.filePath is the same path, kept as a fallback.
  const file = ti.file_path || (tr && tr.filePath) || "";
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
