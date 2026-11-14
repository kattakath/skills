> Superseded 2026-11-14: page-lab was removed; its userscript method lives in plugins/userscript-lab (Claude in Chrome only).

# page-lab v-next — a dedicated browser profile; the human only when needed

**Status: ACCEPTED, steps 1–5 implemented (2026-11-07).** Steps 6–8 (fleet) are open. Deviations found while
building, all measured: `block@1` admits `detector-error` (§7.4 vs §7.1/§7.3); the headed relaunch passes
`--headless=false` and the argv sets `--categoryExtensions=false` (both upstream defaults are TRUE); the
main-document status is the request at the FINAL URL (an iframe is a document request too); `chrome-lab`
carries no emulation tools, so page-diagnose's viewport work stays on the attach entry.
Scope: `plugins/page-lab` in this repo, plus the consumer changes it implies in a Nix fleet.
This document carries no site specifics on purpose.

## 1. Verdict

- **Add a second browser mode; keep the first.** `attach` (today: drive the operator's daily
  Chromium) stays for supervised driving and userscript work, where his logged-in session IS
  the point. `dedicated` becomes the default for unattended work.
- **`dedicated` = the `chrome-devtools` CLI daemon that already ships inside the pinned
  `chrome-devtools-mcp@1.12.0`**, launching a hash-pinned Chrome for Testing from nixpkgs
  (`playwright-driver.browsers-chromium`) on a page-lab-owned profile dir, headless, over a
  **pipe** — no TCP debugging port.
- **A deterministic gate wraps it**: fixed detectors after every navigation, a JSONL queue, a
  typed `page-lab/block@1` event, a headed handoff on the SAME profile, and a resume that skips
  finished work. The model plugs in only at named seams.
- **Nothing new is hand-rolled where an upstream already ships it**: the driver, the daemon,
  the browser build and the profile lock are all upstream. Custom code is the detector rules,
  the queue files and the launcher's closed argv.

## 2. Why — what attach mode costs today (measured)

| Problem | Evidence |
|---|---|
| Background tabs stall | lazy-loading stalled at 8/197 rows in a non-front tab |
| Focus stealing | automation in the daily browser raises its windows |
| Work and personal sessions mix | the daily profile holds official-account cookies, a password-manager native host and a userscript that fires requests on its own |
| **The daily browser listens on `127.0.0.1:9222` with no auth** | `lsof -iTCP -sTCP:LISTEN` (2026-11-07). Any local process can drive every logged-in origin |
| **The Kapture bridge listens on `127.0.0.1:61822`** | `kapture-mcp@2.6.1` `dist/origin-policy.js` admits requests with no `Origin` header and one third-party web origin; its `/assistants` endpoints write MCP client config files |

The last two rows are live exposures independent of this redesign (§ 10).

## 3. Big picture

```
┌─────────────────────────────────┐
│    gate nav: next queue item    │◄────┐
└────────────────┬────────────────┘     │
                 │                      │
                 ▼                      │
┌─────────────────────────────────┐     │
│    navigate + fixed detectors   ├─────┼─blocked────────┐
└────────────────┬────────────────┘     │                │
                ok                      │                │
                 ▼                      │                ▼
┌─────────────────────────────────┐     │    ┌───────────────────────┐
│model extracts via CLI, gate done├─────┤    │exit 10 + block@1 event│
└─────────────────────────────────┘     │    └───────────┬───────────┘
                                        │                │
                                        │                │
┌─────────────────────────────────┐     │                │
│     handoff: SAME dir HEADED    │◄────┼────────────────┘
└────────────────┬────────────────┘     │
                 │                      │
                 ▼                      │
┌─────────────────────────────────┐     │
│     resume: skip done.jsonl     ├─────┘
└─────────────────────────────────┘
```

## 4. Profiles as a first-class concept

### 4.1 Registry — schema `page-lab/profile@1`

| Field | Meaning |
|---|---|
| `name` | `daily`, `lab`, `lab-diag`, or an operator-added name |
| `mode` | `attach` \| `dedicated` |
| `userDataDir` | attach: the daily browser's dir; dedicated: derived (below), never model-supplied |
| `headless` | default `true` for dedicated |
| `executable` | `{source: "env" \| "nix" \| "path", path}` |
| `allowedOrigins[]` | dedicated only: feeds `--allowedUrlPattern` |

- **The plugin ships path-free defaults only**: `daily` (attach), `lab` (dedicated, owned by
  `page-lab-gate` runs, keeps the human's sign-ins) and `lab-diag` (dedicated, owned by the
  `chrome-lab` MCP entry, no sign-ins needed).
- **One owner per profile dir.** Chromium's lock allows one process per dir (§ 7.5), and the
  MCP server has no flag to attach to the CLI daemon's pipe-held browser (`--help`, 1.12.0).
  So the gate and the MCP entry never share a dir; a collision anyway exits 12.
- **The operator overlay** lives at `${XDG_CONFIG_HOME}/page-lab/profiles.json`. A Nix fleet
  writes it with Home Manager. Neither repo holds a per-person path.
- **Dedicated profile dirs** live at `${XDG_STATE_HOME:-~/.local/state}/page-lab/profiles/<name>`,
  created `0700`, excluded from Time Machine (`tmutil addexclusion`). Never under a repo, a
  sync folder or an agent scratchpad.
- **Absorbs existing drift**: four unmanaged ad-hoc profile dirs already sit under
  `~/Library/Application Support/` (measured; no reference in either repo).
- **Prior art in-repo**: `references/routes.md` § "The three profiles" (daily / isolated debug
  / ship). The registry formalises that table; it adds no new idea.

### 4.2 How a session picks a profile — two MCP entries

| Entry | Mode | Who uses it |
|---|---|---|
| `chrome-devtools` | attach — **unchanged, byte-for-byte behaviour** | supervised-driving, userscript-author, `/pick` |
| `chrome-lab` | dedicated on `lab-diag`, MCP-launched, pipe | page-diagnose, `/devtools`, site-redesign survey |

- Tool names `mcp__plugin_page-lab_chrome-devtools__*` stay stable for every existing skill.
- **Rejected: one entry + an env var.** The profile is fixed when the server spawns, and
  supervised driving starts mid-session by phrase.
- **Rejected: `--config --watchConfig`.** Upstream: "options used to launch or connect to the
  browser still require a restart" (`mcp-options.js`).
- **Cost**: the tool list doubles while both entries load. Measure with
  `devtools-doctor --verify-tools` before shipping; if it bites, `chrome-lab` takes `--slim`
  or category flags.

### 4.3 One launcher — `scripts/browser.sh <profile> {up|headed|down|status|print-argv}`

- Absorbs `chrome-devtools-attach.sh` (its attach branch stays as is) and `route-up --tier 1`.
- **In dedicated mode it is the ONLY argv assembler.** No `"$@"` pass-through. It reads a
  closed set: profile name, headless flag, allowlist.
- `print-argv` is a dry run that a test asserts on (§ 7.3).

## 5. Driving — the harness seam

**ADOPT the `chrome-devtools` CLI** (`bin.chrome-devtools` in `chrome-devtools-mcp@1.12.0`).

- A daemon with `start/stop/status`. Every MCP tool is a subcommand, with
  `--output-format json` and the same launch flags (`--headless --executablePath --userDataDir`).
  Measured end to end against a local 403/302/429 fixture with the Nix CfT build.
- **Transport**: the daemon holds Chromium over a pipe and listens on a **unix socket** in a
  per-user runtime dir created `0700`; it refuses to start if that dir is group/other-writable
  (`build/src/daemon/daemon.js`, `utils.js#getRuntimeHome`). Same-uid only — strictly narrower
  than a `127.0.0.1` TCP port.
- **This settles the one design conflict the review raised:**

| Option | Detectors deterministic? | Exposure | Handoff |
|---|---|---|---|
| A. MCP server launches, pipe | no — the model must call and read tools | none | MCP restart |
| B. Launcher owns Chromium + `--remote-debugging-port`, MCP attaches | yes (raw CDP) | **TCP port, any local process** | relaunch; MCP reconnects |
| **C. CLI daemon owns Chromium over pipe (chosen)** | **yes — a script calls the CLI** | **unix socket, 0700, same uid** | `stop` → relaunch headed |

- **Rejected: `apify/mcpc`** (0.8.0, Apache-2.0). It would add a hop and a pin to reach tools
  the upstream CLI already exposes.
- **Rejected: `crawlee-python` `BasicCrawler`.** Read at source (`_basic_crawler.py`):
  `ImpitHttpClient()` by default (impit impersonates `firefox`), `retry_on_blocked=True`
  documented as "attempts to bypass bot protections", `max_session_rotations=10`. Three evasion
  defaults; the stance forbids all three. Its Playwright crawlers also default
  `fingerprint_generator='default'` (confirmed). A JSONL queue is smaller than the opt-outs.
- **Prior-art search** (3+ queries): no mature, evasion-free stop → handoff → resume tool
  exists. A 3-week-old state-machine project is a useful precedent, too immature to adopt;
  the most-starred candidate is an anti-bot evasion product (rejected on stance).

## 6. Browser binary

**ADOPT nixpkgs `playwright-driver.browsers-chromium`.**

| Candidate | darwin? | Pinned by content hash? | Verdict |
|---|---|---|---|
| nixpkgs `chromium` / `ungoogled-chromium` | **no** — `meta.platforms` is `*-linux` only | yes | impossible on the Mac |
| **`playwright-driver.browsers-chromium`** | **yes** (aarch64-darwin + aarch64-linux) | **yes** (fixed-output CfT 156.0.8078.4) | **ADOPT** — 386 MB closure, runs headless from `/nix/store`, cookies persist (measured) |
| `google-chrome` | yes | — | rejected: unfree, self-updates |
| `@puppeteer/browsers` CfT | yes | version string only | rejected: no content hash |
| Homebrew Chromium cask | yes | — | rejected: same family as the daily browser; drifts with it |

- The pin lives on the **consumer** side (the plugin cannot carry a `/nix/store` path): the
  fleet sets `PAGE_LAB_CHROME=<store path>` or the overlay's `executable`. Without it, the
  launcher falls back to the server's own resolution and says so.
- CfT is ad-hoc signed and `spctl` rejects it; it runs because it carries no quarantine xattr
  (true of both the Nix and the npx copies). Weak point: a future macOS enforcing Gatekeeper on
  un-quarantined ad-hoc binaries.

## 7. The gate — challenge stop, handoff, resume

### 7.1 CLI contract — `page-lab-gate {run|handoff|resume|status} --profile P --run R`

| Exit | Meaning |
|---|---|
| 0 | queue drained |
| **10** | blocked — handoff needed (event written) |
| **11** | cooldown active — aborted |
| **12** | profile locked by a live process that is not ours |
| **13** | egress outside the profile's `egress` policy — nothing navigated (§7.7) |

Existing codes checked for collisions: `EXIT_NO_TARGET=3`, `EXIT_UNSUPPORTED_NODE=7`,
`route-up` 2, doctor 3 (13 re-checked 2026-11-07: unused in the plugin).

**The model's seams — the only ones:**
- **Navigation goes through the gate only:** `page-lab-gate nav --run R` pops the next queue
  item, navigates, runs every detector, and either prints the page id (exit 0) or writes the
  event and exits 10. In unattended mode the model never calls `navigate_page` itself, so it
  cannot route around a detector. A test asserts the run's skill text never names
  `navigate_page`.
- **Per item, the model extracts or acts** through the same CLI (`chrome-devtools <tool>
  --output-format json`, same session id), validating its output against the job's JSON Schema.
- **`page-lab-gate done --run R --item <hash> --result <file>`** validates the result and
  appends to `done.jsonl`. An item without a valid `done` stays pending, so resume redoes it.

### 7.2 Files — `${XDG_STATE_HOME}/page-lab/runs/<run-id>/`

| File | Content |
|---|---|
| `queue.jsonl` | pending items |
| `done.jsonl` | append-only, keyed by URL hash — resume skips these, so no duplicate work |
| `events.jsonl` | `page-lab/block@1` events |
| **`${XDG_STATE_HOME}/page-lab/cooldown.json`** (one file, all runs) | origin → state; cleared only by the human (§ 7.5) |

Run state is never in a repo or in the profile dir (that dir is Chromium's).

- **The cooldown is shared, not per run** (revised during implementation). Counted per run, a
  peer session's measurement let 4 refused requests through in 30 s: each fresh run saw a fresh
  window. Blocks are counted per ORIGIN, whichever run hit them.
- **The agent never reads these files.** The fleet denies its tools `.local/state/page-lab/**`;
  run state reaches the model only through `page-lab-gate status` (counts and the last event).

### 7.3 Detectors — fixed rules, run after EVERY navigation

**Trap (measured): `navigate_page` reports "Successfully navigated" on a 403 and a 429.** A
detector trusting it fails OPEN.

| Signal | Source (CLI, JSON) | Rule |
|---|---|---|
| main-document status | `list_network_requests --resourceTypes document` | 403 / 429 / 503 → STOP |
| final URL | navigate JSON | matches a login-path rule or crossed to an identity origin → STOP `login-wall` |
| title | navigate JSON | challenge-title list → STOP |
| challenge frames | one fixed `evaluate_script` probe | `cf-chl` markers, hCaptcha / reCAPTCHA iframe origins → STOP |
| consent / age gate | the same probe, fixed selector list | → STOP |
| **probe unparseable** | `evaluate_script` wraps JSON in a markdown fence | **parse failure → STOP** (fail closed) |
| `cf-mitigated` header | `get_network_request --reqid <main>` (added in implementation) | present → STOP `challenge-cf`. `--redactNetworkHeaders` redacts the VALUE, keeps the key (measured) |

- **Challenge markers need corroboration** (revised in implementation): a cf marker or a captcha
  iframe counts only with status ≥ 400 or `cf-mitigated` present. Cloudflare injects a beacon
  script (`/cdn-cgi/challenge-platform/scripts/jsd/main.js`) into ordinary 200 pages; a bare
  marker rule flagged a real page and wrote a false cooldown (peer measurement). Consent and age
  gates still stop on their own.
- **Evidence** = status + three allowlisted headers (`server`, `cf-ray`, `cf-mitigated`; never
  `set-cookie`) + the title capped at 120 chars with token-like runs redacted + the rule name.

- The detector list is data in the plugin, versioned, unit-tested against local fixtures. No
  model judgement decides "is this a challenge".
- **Mechanical no-evasion test**: `browser.sh print-argv` must NOT contain
  `proxy|AutomationControlled|user-agent|ignoreDefaultChromeArg|acceptInsecureCerts|stealth`,
  and MUST contain `--categoryEmulation=false` (removes the UA-override tool) and
  `--redactNetworkHeaders`.

### 7.4 Envelope — a sibling schema, not a widened one

- `pick@1` declares itself "never widened in place", and its `status` says process outcomes
  "exit non-zero WITHOUT an envelope". Adding `blocked` there is exactly a widening.
- New `references/block-envelope.schema.json` = **`page-lab/block@1`**: the same keyword
  surface (no `$ref`, `additionalProperties:false`), shared vocabulary
  (`schema`, `measuredAt`, `url`, `origin`, `notes`), plus `reason` enum
  (`http-403|http-429|http-503|challenge-cf|hcaptcha|recaptcha|login-wall|consent-gate|age-gate`),
  `evidence` (status code, matched rule NAME — never markup), `profile`, `runId`, `queuePos`.
- `envelope.mjs#validate(obj, schema)` is already parameterised: **zero new validator code**;
  add `buildBlock()` beside `build()`.

### 7.5 Handoff and cooldown

**Handoff** (`page-lab-gate handoff`):
1. `readlink SingletonLock` → host-pid; check it is alive and ours.
2. Stop the headless daemon gracefully. A clean exit removes the `Singleton*` links (measured).
3. Relaunch the SAME dir **headed**, with identical flags except `--headless`.
4. The human clears the challenge or signs in, then quits the window.
5. `resume` relaunches headless and continues from `queue.jsonl`.

- **Cookies survive the round trip** — written headless, read back both headless and headed
  after a restart, with identical flags (measured). Flags MUST stay identical: the defaults
  include `--use-mock-keychain --password-store=basic`, and a launch without them would read
  with a different key.
- **Chromium enforces the profile lock**: a second headless opener exits 21, "Aborting now to
  avoid profile corruption" (measured). The worse case is a HEADED second open, which silently
  hands off to the live process — hence step 1. **Rejected: our own flock file** — a second
  lock beside Chromium's, and the two can drift.

**Cooldown** — slow down, never evade:

| Event | Action |
|---|---|
| 1st block on an origin | stop that origin, record the event; never auto-retry the URL |
| 2nd block on the same origin within 24 h | origin enters cooldown; **only the human clears it** (no timer) |
| 3 origins in cooldown in one run | abort the run (exit 11) |
| between attempts | never vary UA, viewport, proxy or timing |

### 7.6 Throttling — headless alone does NOT fix it (measured)

| Non-front tab, Chromium 152 headless=new, 2 s | visibility | rAF frames | timeouts |
|---|---|---|---|
| no flags | hidden | 1 | 10 |
| 3 anti-throttle flags | hidden | 1 | 39 |
| `Page.bringToFront` | visible | 122 | 447 |

**Rule: one working tab per run, and `select_page <id> --bringToFront` before each navigation.**

### 7.7 Egress preflight (added 2026-11-07)

**Why (peer measurement, site-agnostic):** a real managed challenge was caused by VPN egress in
an unexpected country; a preflight against `https://www.cloudflare.com/cdn-cgi/trace` that
refused on unexpected egress prevented it. A second measurement set the placement: a "prove it
refuses" demo reached the site because the VPN changed **between the check and the run** — so
the check runs inside the gate command that does the work, never as a separate step.

- **When:** `run` (after the daemon starts; `--no-start` defers it to `resume`, or to the first
  `nav` when a daemon is already up), `resume`,
  and `nav` when the last check is absent, ≥ 10 min old, did not pass, or was taken under a
  different policy. Recorded as `meta.json#egress`. Placed in `nav` after the drained check and
  before the cursor moves, so a refusal leaves the queue exactly as it was.
- **Through the browser:** the working tab opens the trace URL and one fixed `evaluate_script`
  filters the `key=value` body **in the page** to `loc, colo, warp, gateway, http, tls`. The
  trace's `ip` never reaches node, stdout, an event or a run file; `parseEgress` also rejects
  any other key. Node's own `fetch` was rejected: it measures node's egress, not the browser's.
- **Allowlist:** the trace origin is added to `--allowedUrlPattern` by every gate launch
  (`dedicatedArgv` `extraOrigins`), only when the profile already has an allowlist — adding one
  pattern to an open profile would make it trace-only. The handoff still differs by
  `--headless` alone.
- **Policy:** profile@1 `egress: {allowLoc: [ISO-3166 alpha-2], allowWarp: [off|on|plus]}`,
  dedicated only. Mismatch → `page-lab/block@1` `reason: egress-mismatch`, detector `egress`,
  evidence `loc/colo/warp`, exit **13**. Unreadable trace with a policy → `detector-error`,
  exit 10 (fail closed). Neither writes a cooldown entry: the site did nothing. No policy → it
  measures, records and prints one stderr line, never refuses.
- **Tests:** the fixture server's `/cdn-cgi/trace` stands in for the real one via
  `PAGE_LAB_EGRESS_TRACE_URL`, honoured **only** for `http://127.0.0.1` so production cannot be
  pointed at a host that always answers `CA`. No test reaches the real trace.
- **Weak point:** a point-in-time read. Between rechecks (≤ 10 min) a VPN change goes unseen
  until the next `run`/`resume`/recheck.

## 8. Security posture of `dedicated` mode

| Asset / surface | attach (today) | dedicated |
|---|---|---|
| official-account cookies | all | only sites the human signed into in that profile |
| extensions (userscripts, password host) | loaded | none (`--disable-extensions` is a default) |
| debugging transport | TCP `:9222`, no auth | pipe; daemon socket 0700 same-uid |
| prompt-injection reach | any logged-in origin | bounded by `--allowedUrlPattern` |

Flags for unattended runs, with what each costs:

| Flag | Cost |
|---|---|
| `--allowedUrlPattern=<job origins>` | SSO / CDN hops must be listed; needs Chrome 149+ (CfT 156 ok) |
| `--fileNavigations=false` | none |
| `--workspace=<run dir>` only | drops `$TMPDIR` and scratchpads that today's launcher adds |
| `--categoryExtensions` unset, `--categoryEmulation=false` | no extension tools, no UA override |
| `--redactNetworkHeaders`, `--no-usage-statistics`, `--no-performance-crux` | none |
| WebMCP / third-party categories left off | a page cannot publish tools to the model |

- **Honest by default**: Puppeteer keeps `--enable-automation` (`navigator.webdriver=true`);
  headless announces `HeadlessChrome` in its UA (measured). Neither is overridden.
- **Cookies at rest are effectively plaintext** (mock keychain). Compensated by location,
  `0700`, Time Machine exclusion, and a **user-tier Read deny** on
  `.local/state/page-lab` via the fleet's secret-read-paths list. The deny binds the agent's
  tools, not the launcher process. Managed tier: not until proven not to bite the launcher.
- `--ignoreDefaultChromeArg` is not a fix for the plaintext cookies: it drops ALL Puppeteer
  defaults, `--enable-automation` included.

## 9. Plan (after approval)

| Step | Repo | Change | Check |
|---|---|---|---|
| 1 | skills | `profile@1` + `block@1` schemas, `buildBlock()` | schema fixtures in `scripts/fixtures/` |
| 2 | skills | `browser.sh` (attach branch = today's script) + `print-argv` no-evasion test | `.mcp.json` attach entry behaves identically |
| 3 | skills | `page-lab-gate` + detector rules + local 403/302/429/challenge fixtures | fixture run: each rule STOPs, exit 10, event validates |
| 4 | skills | handoff + resume + cooldown | resume after handoff re-processes 0 done items |
| 5 | skills | `chrome-lab` MCP entry; repoint page-diagnose, `/devtools`, redesign survey | `devtools-doctor --verify-tools` tool count |
| 6 | fleet | pin `playwright-driver.browsers-chromium`, export `PAGE_LAB_CHROME`, HM-written `profiles.json` | `nix build` both systems |
| 7 | fleet | Read deny on `.local/state/page-lab`; teach or retire `nix-chromium-debug` (it refuses while ANY Chromium runs) | guard tests |
| 8 | fleet | fix the `mcp-launcher-parity` comment — the check iterates `local.pluginMcp.servers` (`["postgres"]`), not every plugin `.mcp.json` | doc only |

Plugin changes ship through the auto-updating marketplace; the fleet's `kattakath-skills` pin
bumps only if `page-lab-pick` learns `--profile`.

## 10. Out of scope, but found — fix independently

- **`:9222` on the daily browser, unauthenticated.** Narrow it to supervised sessions (start
  on demand, stop after) rather than always-on.
- **Kapture bridge `:61822`.** No-`Origin` admission + a third-party web origin + config-writing
  endpoints. Keep it supervised-only; consider dropping it from the always-loaded `.mcp.json`.

## 11. Derived vs assumed — and the weakest assumption

| Claim | Kind |
|---|---|
| pipe launch, lock semantics, cookie round trip, 403-reads-as-success, throttling table | **measured** this pass |
| daemon socket is 0700 same-uid | **read at source**, not run with `lsof` |
| cookies decryptable at rest under mock keychain | **derived** from flag semantics, not measured |
| detector rules catch the challenges that matter | **judgement** until a fixture + real-run census |

- **Weakest assumption: "the human only when needed."** Headless announces `HeadlessChrome`,
  so it may trip challenges MORE often, making handoffs frequent. What settles it: a week of
  `block@1` counts per origin, headless vs headed-offscreen. If headed-offscreen wins, the
  profile's `headless` default flips — the design does not change.
  - **Measured 2026-11-07 — the assumption is weak, and headed-offscreen is NOT the way out.**
    - A peer A/B from a clean residential egress, one run, n=1: honest headless was
      **challenged 1/1** (403, `cf-mitigated: challenge`, "Just a moment..."). The fingerprinted,
      TLS-impersonating and UA-overridden variants passed 0/2, and all three are banned by § 7.3.
      From a VPN egress every variant was challenged, so IP reputation dominates.
    - Headed-offscreen on macOS (CfT 156, `--window-position=-32000,-32000`):
      - macOS **clamped the window back onscreen** at `0,33`, 1280x800.
      - CfT **became the frontmost app** after the first navigation (`NSWorkspace.frontmostApplication`).
      - It is neither offscreen nor focus-safe, so it is rejected.
    - **Consequence: the default stays headless, and handoffs are the expected path,** not the
      exception, for origins behind a managed challenge.
    - The honest levers left: slower pacing, egress policy (§ 7.7), and a once-per-origin
      headed sign-in whose cookies persist. Overriding the UA is spoofing and stays banned.
- Runner-up: a launch WITHOUT the mock-keychain flags losing cookies (inferred; testing it
  creates a Keychain item, so it needs the operator's OK).
