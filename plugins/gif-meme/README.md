# gif-meme

Turn a short video into a **looping GIF that fits a byte budget**, then publish it where GIF
search actually looks — with the per-site footguns measured and pre-empted.

## What it ships

| Component | What it does |
|---|---|
| `skills/gif-meme` | The method: encode to a budget, choose the engines with the user, drive both upload forms through Claude in Chrome, report honestly (pending vs. live) |
| `skills/gif-meme/references/upload-flows.md` | The measured click-paths for Tenor and GIPHY: which inputs are hidden, which tag box drops input, what each success state looks like |

## The facts it exists to carry

| Fact | Measured |
|---|---|
| **Tenor** uploads from a plain account become **searchable** (Gboard, WhatsApp, Discord…) after review of **up to 48 h**; nothing public exists until then | Tenor FAQ + a live upload sitting at "CONTENT PENDING REVIEW" |
| **GIPHY** uploads from a plain account are **never in search**; only approved Artist/Brand channels are, and the application form is gated behind **5 public uploads** | GIPHY support + `giphy.com/apply` redirecting to "Upload Some GIFs!" at 2/5 |
| GIF has no rate control, so "fit under 1 MB" is a **ladder of encodes**, not a flag | 15 encodes of one clip; see the package header |
| **Bayer dither** costs ~10%, **gifsicle `--lossy=100`** saves ~34% | 1.59 → 1.45 → 0.96 MB at 400 px |
| A **256×256 centre crop was bigger** than the 400×308 letterbox of the same clip | 1.14 MB vs 0.96 MB raw — cropped-off background was free in LZW |
| Tenor's six file inputs are `display:none`; the visible button does not open a chooser | The visible button does not attach a file; target the hidden input itself (on Claude in Chrome: `find` + `file_upload`, not yet measured) |
| GIPHY's tag input **drops every other tag** when Enter follows the text in one call | 7 of 15 registered; one text entry + one separate Enter per tag registers all |
| `tenor.com/upload` is a **404**; the uploader is `/gif-maker` | — |

## Requires

- **`media-gif` on PATH** — the encoder, from `kattakath/nix-config`'s media-cli capsule
  (`modules/features/media-cli/packages/media-gif.nix`, enabled by `local.mediaCli.enable`). It
  pins its own ffmpeg and gifsicle. This plugin ships **no** encoder of its own: one source of truth
  for the ladder, and the shellcheck/CI that the Nix build gives it.
- **Claude in Chrome** — the browser extension and its `mcp__claude-in-chrome__*` tools, acting in
  the user's own Chrome. It is not a plugin dependency; this plugin runs no MCP server of its own.
  A per-site permission wall is the operator's to grant.
- **The user's Tenor (Google) and GIPHY accounts.** Sign-in is the user's step, every time.

## What it does not do

- Stickers (transparent GIFs) — a different upload path on both sites.
- Video-to-video transcodes — `media-transcode`.
- Any upload API. Tenor has none for third parties; GIPHY's adds a credential for a ninety-second
  form. See the reference file for when that trade flips.
