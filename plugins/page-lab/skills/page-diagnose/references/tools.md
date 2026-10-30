<!-- page-lab:tools-measurement
MEASURED_PACKAGE=chrome-devtools-mcp
MEASURED_VERSION=1.12.0
MEASURED_TOOL_COUNT=32
MEASURED_AT=2026-10-30
-->

# Tool catalogue

**The block above is machine-readable and load-bearing.** `scripts/devtools-doctor.sh
--verify-tools` parses it, counts the pinned server's real `tools/list`, and reports
`TOOLS_DRIFT=yes|no`. **Edit it only after re-running that measurement** — a hand-edited header
turns the one drift detector this plugin has into a liar. The prose below must agree with it.

**`MEASURED_VERSION` must equal the version pinned in `scripts/chrome-devtools-attach.sh`.**
The doctor measures the version written HERE, not the one the launcher runs — so a launcher bump
without a re-measure still reports `TOOLS_DRIFT=no`, against the old release.

**The header counts the DEFAULT tool set**, which is what the doctor's runner starts. The
plugin's launcher also passes `--categoryExtensions` (`.mcp.json` sets
`CDP_CATEGORY_EXTENSIONS=1`), which adds the Extensions group below — so a live session sees
more tools than the header. Both counts and their date live in [F-CDP-29TOOLS]; this file
lists the names.

**Upstream's generated `docs/tool-reference.md` is written from `main`** and describes more
than the pinned release ships. So a gap between a doc and this file is the expected state, not
evidence of a broken install — **re-measure the pinned version before claiming any gap is real.**

Trust this list for what can be called today; trust upstream's doc for where the project is
heading. Never assume a tool exists because a doc mentions it. The client's own tool list is
the final authority.

## The tools that exist in the pinned release

`get_css_styles` and the screencast pair are grouped by this file, not by upstream.

### Input (9)

`click` · `drag` · `fill` · `fill_form` · `handle_dialog` · `hover` · `press_key` ·
`type_text` · `upload_file`

Elements are addressed by **`uid` from a page snapshot**, never by CSS selector. The loop is
`take_snapshot` → read the `uid` → act, and a `uid` goes stale as soon as the DOM changes.

- **`fill_form` over repeated `fill`/`click`.** Upstream is explicit: always prefer it for
  forms — faster, more reliable, fewer turns.
- **`handle_dialog`** is the only exit from a JavaScript dialog. A dialog blocks the page, so
  an unhandled one makes every later call look hung.
- Most accept `includeSnapshot` (default `false`); setting it saves a follow-up snapshot.

### Navigation (6)

`navigate_page` · `new_page` · `close_page` · `list_pages` · `select_page` · `wait_for`

Page-scoped tools take a **`pageId`** — confirm it with `list_pages` rather than assuming the
last-opened page is current. Prefer `wait_for` to sleeping; the automation already waits for
action results.

### Emulation (2)

`resize_page` · `emulate`

- **`resize_page`** sets an exact viewport — the precise instrument for CSS breakpoints. One
  variable, repeatable, comparable between runs.
- **`emulate`** covers device presets, CPU throttling and network conditions. Several
  variables at once: right for "does this work on a slow phone", wrong for "which breakpoint
  fires".

### Performance (3)

`performance_start_trace` · `performance_stop_trace` · `performance_analyze_insight`

Record with `reload: true` to capture load and `autoStop: true` to end at a settling point,
then analyse a **named insight** rather than reading raw trace JSON.

This is the group `--no-performance-crux` protects: without it, trace URLs leave the machine.

### Network (2)

`list_network_requests` · `get_network_request`

List first, then fetch the single request for headers, timing and status.

### Debugging (7)

`evaluate_script` · `list_console_messages` · `get_console_message` · `take_snapshot` ·
`take_screenshot` · `lighthouse_audit` · `get_css_styles`

- **`evaluate_script`** runs JavaScript in the page — how measurement probes execute.
- **`take_snapshot`** returns structured content and every `uid`; **`take_screenshot`**
  returns pixels. Snapshots drive interaction, screenshots are evidence for a human.
- **`list_console_messages`** carries source-mapped stacks. An empty console where an error
  was expected usually means the code never ran.

### Screencast (2)

`screencast_start` · `screencast_stop`

### Memory (1)

`take_heapsnapshot`

Only the capture tool ships in the pinned release.

### Extensions (5) — only with `--categoryExtensions`

`install_extension` · `list_extensions` · `reload_extension` · `trigger_extension_action` ·
`uninstall_extension`

Absent from the default set (and so from the header's count); present because this plugin's
launcher opts in. **Exposed is not exercised:** whether `install_extension` can load a userscript
manager into a driven browser has not been measured, so do not plan on it until it is.

## Documented upstream but ABSENT from the pinned release

Do not plan a workflow around these until a measurement shows them present:

| Group | Missing tools | Consequence |
|---|---|---|
| **Memory** | the other 12 `*_heapsnapshot*` tools | A snapshot can be captured but not compared or queried, so the compare-two-snapshots leak workflow is unavailable. |
| **PWA** | `get_os_app_state`, `install_pwa`, `launch_pwa`, `uninstall_pwa` | No PWA lifecycle control. |
| **Third-party / WebMCP** | `list_3p_developer_tools`, `execute_3p_developer_tool`, `list_webmcp_tools`, `execute_webmcp_tool` | Not available. |
| **Misc** | `click_at` | No coordinate clicking. |

**The clean-room authoring route is still unproven.** The Extensions tools exist, but nothing
here has shown one loading a userscript manager into a driven browser. Until a measurement
does, the authoring loop ends where it always did: **a human clicking Install**, in their own
browser, on their own profile.

## Slim mode

`--slim` exposes a reduced set (3: `navigate`, `evaluate`, `screenshot`, re-measured on the
pinned release) for basic navigate-and-read work. The full set is needed for tracing, snapshots
and network inspection.

## How this list was produced — the re-measure recipe

An MCP `initialize` handshake, then `notifications/initialized`, then `tools/list` over stdio,
against the real server in **both** modes. `scripts/devtools-doctor.sh --verify-tools`
mechanises it and compares the count to the header above.

Repeat it after any version bump and update **both** the header and the prose — never edit this
file from a changelog, and never edit the header alone.
