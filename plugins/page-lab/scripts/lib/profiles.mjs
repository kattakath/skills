// The profile registry (page-lab/profile@1) and THE dedicated-mode argv.
//
// WHY ONE MODULE. Two callers launch a dedicated browser: scripts/browser.sh (up / headed /
// mcp / print-argv) and scripts/page-lab-gate.mjs (run / resume / the handoff relaunch). If
// each assembled its own argv, the headless and headed launches could drift — and the design
// measured that a launch with different flags reads the profile's cookies with a different key
// (docs/page-lab-vnext-design.md §7.5). So the argv is built here, once, from a CLOSED set of
// inputs: the profile record, a headless flag, a workspace dir. Nothing a caller passes on a
// command line is forwarded.
//
// Also a tiny CLI, because browser.sh is POSIX sh and cannot parse JSON:
//   node profiles.mjs mode <name>                       attach | dedicated
//   node profiles.mjs argv <name> headless|headed [ws]  one server flag per line
//   node profiles.mjs dir <name>                        the derived profile dir
//   node profiles.mjs workspace <name>                  the default --workspace dir
//   node profiles.mjs session <name>                    the CLI daemon session id
//   node profiles.mjs lock <name>                       free | stale | held <pid> | foreign <host>
// Exit 2 on an unknown profile or an invalid overlay, naming the rule.

import { existsSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatErrors, loadProfileSchema, validate } from './envelope.mjs';

export const CDM_VERSION = '1.12.0';
export const CDM_PACKAGE = `chrome-devtools-mcp@${CDM_VERSION}`;

// Path-free on purpose: a plugin cannot carry a per-person path or a /nix/store path.
export const DEFAULT_PROFILES = Object.freeze([
  { schema: 'page-lab/profile@1', name: 'daily', mode: 'attach' },
  // Owned by page-lab-gate runs; keeps the human's sign-ins across handoffs.
  { schema: 'page-lab/profile@1', name: 'lab', mode: 'dedicated', headless: true },
  // Owned by the chrome-lab MCP entry; needs no sign-ins. Never shared with `lab`: Chromium
  // allows one process per dir and the MCP server cannot attach to the daemon's pipe.
  { schema: 'page-lab/profile@1', name: 'lab-diag', mode: 'dedicated', headless: true },
]);

export class ProfileError extends Error {}

function home(env) {
  return env.HOME || homedir();
}

export function stateHome(env = process.env) {
  return env.XDG_STATE_HOME || join(home(env), '.local', 'state');
}

export function configHome(env = process.env) {
  return env.XDG_CONFIG_HOME || join(home(env), '.config');
}

export function overlayPath(env = process.env) {
  return join(configHome(env), 'page-lab', 'profiles.json');
}

/**
 * Defaults, then the operator overlay merged onto them BY NAME. The overlay is the file a Nix
 * fleet writes with Home Manager:
 *
 *   { "profiles": [ { "name": "lab", "executable": { "source": "env" } }, … ] }
 *
 * Entries are PARTIAL: each top-level key replaces the default's (executable and
 * allowedOrigins replace wholesale, never deep-merge), schema is filled in, and the MERGED
 * record must validate as page-lab/profile@1 — so an overlay cannot give a dedicated profile a
 * userDataDir any more than a default could. A name with no default must carry `mode`.
 * Anything else at the top level, or a non-array `profiles`, is refused.
 */
export function loadRegistry(env = process.env) {
  const byName = new Map(DEFAULT_PROFILES.map((p) => [p.name, p]));
  const path = overlayPath(env);
  if (!existsSync(path)) return byName;
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ProfileError(`${path}: not JSON — ${err.message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.profiles)) {
    throw new ProfileError(`${path}: must be {"profiles": [ … ]} — partial page-lab/profile@1 entries, merged by name`);
  }
  const extra = Object.keys(doc).filter((k) => k !== 'profiles');
  if (extra.length) throw new ProfileError(`${path}: unexpected top-level key(s): ${extra.join(', ')}`);
  for (const [i, entry] of doc.profiles.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.name !== 'string') {
      throw new ProfileError(`${path}: profiles[${i}] needs a "name"`);
    }
    const merged = { ...(byName.get(entry.name) ?? {}), ...entry, schema: 'page-lab/profile@1' };
    const r = validate(merged, loadProfileSchema());
    if (!r.valid) {
      throw new ProfileError(`${path}: profiles[${i}] (${entry.name}) invalid after merge\n${formatErrors(r.errors).join('\n')}`);
    }
    byName.set(entry.name, merged);
  }
  return byName;
}

export function resolveProfile(name, env = process.env) {
  const p = loadRegistry(env).get(name);
  if (!p) throw new ProfileError(`unknown profile "${name}"`);
  return p;
}

/** Derived, never supplied: a dedicated profile cannot be pointed at the daily dir. */
export function profileDir(name, env = process.env) {
  return join(stateHome(env), 'page-lab', 'profiles', name);
}

export function cacheHome(env = process.env) {
  return env.XDG_CACHE_HOME || join(home(env), '.cache');
}

/**
 * The default --workspace (file root for screenshots and uploads). Under the CACHE home, not the
 * state home: the fleet denies the agent's tools ${XDG_STATE_HOME}/page-lab/** (profile cookies,
 * run state), and a screenshot the model saved must stay readable by it. A gate run passes its
 * own run dir instead.
 */
export function defaultWorkspace(name, env = process.env) {
  return join(cacheHome(env), 'page-lab', 'workspace', name);
}

/** The CLI daemon's session id: the name hex-encoded, which upstream's ^[a-fA-F0-9-]+$ admits. */
export function sessionIdFor(name) {
  return Buffer.from(name, 'utf8').toString('hex');
}

/**
 * Executable: PAGE_LAB_CHROME, then the profile's own, then none (the server's own resolution,
 * which the caller announces on stderr). Returns { path, source } or { path: null, source }.
 * A profile that SAYS {source: "env"} and finds PAGE_LAB_CHROME unset is an error, not a
 * fallback: the fleet pinned a browser, and silently launching another one is the drift the
 * pin exists to stop.
 */
export function resolveExecutable(profile, env = process.env) {
  let path = null;
  let source = 'upstream';
  if (profile.executable?.source === 'env' && !env.PAGE_LAB_CHROME) {
    throw new ProfileError(`profile ${profile.name} reads its browser from PAGE_LAB_CHROME, which is unset`);
  }
  if (env.PAGE_LAB_CHROME) {
    path = env.PAGE_LAB_CHROME;
    source = 'env';
  } else if (profile.executable && profile.executable.source !== 'env') {
    path = profile.executable.path;
    source = profile.executable.source;
  }
  if (path !== null) {
    if (!path.startsWith('/')) throw new ProfileError(`executable must be absolute: ${path}`);
    let st;
    try {
      st = statSync(path);
    } catch {
      throw new ProfileError(`executable not found: ${path}`);
    }
    if (!st.isFile()) throw new ProfileError(`executable is not a file: ${path}`);
  }
  return { path, source };
}

/**
 * THE dedicated argv (server flags only; the caller prepends the binary). Same inputs, same
 * output, byte for byte — the handoff relaunch differs from the headless launch by exactly
 * one token, --headless=true → --headless=false. `--headless` is spelled with a value because
 * upstream defaults it to TRUE: omitting it does not give a headed browser [F-CLI-HEADLESS-DEFAULT].
 *
 * What is deliberately absent, and why (§7.3, §8): no --proxyServer, no --chromeArg, no
 * --ignoreDefaultChromeArg (it drops --enable-automation with the rest), no
 * --acceptInsecureCerts, no user-agent override. --categoryExtensions=false is EXPLICIT because
 * upstream turns extension tools ON by default for a launched (pipe) browser.
 *
 * extraOrigins (the gate's egress trace origin, §7.7) WIDENS an existing allowlist and never
 * creates one: a profile with no allowedOrigins has no network allowlist, and adding a single
 * pattern would make it trace-only. Every gate launch passes the same list, so the handoff's
 * one-token difference holds.
 */
export function dedicatedArgv(
  profile,
  { headless = profile.headless !== false, workspace, extraOrigins = [], env = process.env } = {}
) {
  if (profile.mode !== 'dedicated') throw new ProfileError(`${profile.name} is not dedicated`);
  const exe = resolveExecutable(profile, env);
  const argv = [
    `--headless=${headless ? 'true' : 'false'}`,
    `--userDataDir=${profileDir(profile.name, env)}`,
  ];
  if (exe.path) argv.push(`--executablePath=${exe.path}`);
  argv.push(
    '--no-usage-statistics',
    '--no-performance-crux',
    '--categoryEmulation=false',
    '--categoryExtensions=false',
    '--redactNetworkHeaders',
    '--fileNavigations=false',
    `--workspace=${workspace || defaultWorkspace(profile.name, env)}`
  );
  const origins = profile.allowedOrigins ?? [];
  const allow = origins.length ? [...new Set([...origins, ...extraOrigins])] : [];
  for (const o of allow) argv.push(`--allowedUrlPattern=${o}/*`);
  for (const a of argv) {
    // One flag per line is the sh hand-off format; a newline would split an argument.
    if (/[\n\r\0]/.test(a)) throw new ProfileError(`argv token carries a control char: ${JSON.stringify(a)}`);
  }
  return { argv, executable: exe };
}

/**
 * Chromium's own profile lock. SingletonLock is a symlink to "<hostname>-<pid>"; a clean exit
 * removes it (measured). Returns
 *   { state: 'free' } · { state: 'stale', pid } · { state: 'held', pid } · { state: 'foreign', host }
 * A lock from another host cannot be checked from here, so it is never treated as free.
 */
export function lockState(name, env = process.env) {
  let target;
  try {
    target = readlinkSync(join(profileDir(name, env), 'SingletonLock'));
  } catch {
    return { state: 'free' };
  }
  const m = /^(.*)-(\d+)$/.exec(target);
  if (!m) return { state: 'foreign', host: target };
  const [, host, pidText] = m;
  if (host !== hostname()) return { state: 'foreign', host };
  const pid = Number(pidText);
  try {
    process.kill(pid, 0);
    return { state: 'held', pid };
  } catch (err) {
    return err.code === 'EPERM' ? { state: 'held', pid } : { state: 'stale', pid };
  }
}

// ---------------------------------------------------------------------------
// CLI for browser.sh
// ---------------------------------------------------------------------------

function main(argv) {
  const [cmd, name, variant, ws] = argv;
  const usage = 'usage: profiles.mjs mode|dir|workspace|session|lock <name> · argv <name> headless|headed [workspace]';
  if (!cmd || !name) {
    process.stderr.write(`${usage}\n`);
    return 2;
  }
  try {
    const p = resolveProfile(name);
    switch (cmd) {
      case 'mode':
        process.stdout.write(`${p.mode}\n`);
        return 0;
      case 'dir':
        process.stdout.write(`${profileDir(p.name)}\n`);
        return 0;
      case 'workspace':
        process.stdout.write(`${defaultWorkspace(p.name)}\n`);
        return 0;
      case 'session':
        process.stdout.write(`${sessionIdFor(p.name)}\n`);
        return 0;
      case 'lock': {
        const l = lockState(p.name);
        process.stdout.write(`${l.state}${l.pid ? ` ${l.pid}` : ''}${l.host ? ` ${l.host}` : ''}\n`);
        return 0;
      }
      case 'argv': {
        if (variant !== 'headless' && variant !== 'headed') {
          process.stderr.write(`${usage}\n`);
          return 2;
        }
        const { argv: out, executable } = dedicatedArgv(p, { headless: variant === 'headless', workspace: ws });
        if (!executable.path) {
          process.stderr.write(
            'page-lab: no PAGE_LAB_CHROME and no profile executable — chrome-devtools-mcp resolves its own Chrome\n'
          );
        }
        process.stdout.write(`${out.join('\n')}\n`);
        return 0;
      }
      default:
        process.stderr.write(`${usage}\n`);
        return 2;
    }
  } catch (err) {
    if (err instanceof ProfileError) {
      process.stderr.write(`page-lab: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

function isEntrypoint() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (process.argv[1] && isEntrypoint()) {
  process.exitCode = main(process.argv.slice(2));
}
