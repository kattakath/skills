---
name: gif-meme
description: >-
  Make a looping GIF from a short video and publish it where GIF search looks.
  Use when the user asks to "make a GIF from this video", "make it loop", "get
  this GIF under 1 MB", "square it to 256x256", "speed it up to fit 5 seconds",
  "publish this GIF", "put it on Tenor / GIPHY", or "make my meme show up in GIF
  search" (Gboard, WhatsApp, Discord, Slack, iMessage). Encodes with `media-gif`
  (ffmpeg two-pass palette + gifsicle, walking a measured quality ladder to a byte
  budget) and uploads through Claude in Chrome (the browser extension, in the
  user's own Chrome). NOT for video-to-video transcodes (that is `media-transcode`)
  and NOT for stickers with transparency.
---

# GIF meme: encode to a budget, publish to the engines

Two engines power almost every GIF picker, and they differ on the one thing that matters:
whether a fresh account's upload becomes **searchable**.

| Engine | Powers search in | Searchable from a plain account? |
|---|---|---|
| **Tenor** (Google) | Gboard, Google Messages, Google Chat, WhatsApp, Discord, Telegram, Signal | **Yes** after moderation, up to 48 h |
| **GIPHY** (Meta) | Slack, Instagram, TikTok, iMessage, X | **No**. Only approved Artist/Brand channels enter search. The direct link and `@username` search work immediately. Applying needs **5 public uploads** first. |

Neither has an upload API you can use. Both are web forms, so the browser is the tool.

## 0. Requirements, checked before the first command

- **`media-gif` on PATH** — from `kattakath/nix-config`'s media-cli capsule (`local.mediaCli.enable`).
  It carries ffmpeg and gifsicle itself; a bare `ffmpeg` on PATH is not enough.
  Check: `media-gif --help`.
- **Claude in Chrome connected** (the `mcp__claude-in-chrome__*` tools; they are deferred, so
  load them in one ToolSearch call first). Check it is really there: `tabs_context_mcp` must
  return the user's tab group. If it errors, say Claude in Chrome is not connected and stop.
  If a site hits a per-site permission wall, ask the user to grant it; do not reach for another
  browser.
- **A shared GIF path.** `file_upload` accepts only paths the user shared with the session
  (attachments, the session's outputs/uploads folders, or connected folders) and **at most 10 MB per
  call**. Write the encoded GIF into such a folder, or ask the operator to share the file, and
  keep it <= 10 MB for this rail (`--budget 8M` fits).
- **The user's own accounts.** Tenor signs in with Google; GIPHY with its own login. The user
  authenticates; you never type a credential.

## 1. Encode

```bash
media-gif --budget 1M --max-seconds 5 in.mp4            # letterboxed, best quality under 1,000,000 bytes
media-gif --budget 1M --max-seconds 5 --square --width 256 in.mp4   # centre-crop, 256x256
media-gif --budget 8M --max-seconds 6 in.mp4            # GIPHY's published spec (480 px, <8 MB, ≤6 s)
```

It prints the output path on stdout and, on stderr, the rung it stopped at and a line ending
`loops forever` — that line is a byte-level check of the NETSCAPE2.0 extension, not an echo of
the flag. **Send the GIF to the user and get a click-to-select confirmation before publishing**
anything: a published GIF is public the moment the form submits.

What the budget mode does, and why in that order, is in the package header
(`modules/features/media-cli/packages/media-gif.nix`): fps and palette are walked before
resolution, dither is dropped early, gifsicle's lossy pass runs last at each rung. The order is
measured, not taste — see Pitfalls.

## 2. Decide the targets with the user

Present as options, recommended first:

- **Tenor** — searchable, the one that reaches phones.
- **GIPHY** — shareable link now; search placement only after an Artist/Brand channel is approved.
- **GIPHY + apply for Artist channel** — only possible once the channel holds **5 public GIFs**.
  Until then `giphy.com/apply` redirects to an "Upload Some GIFs!" page; say so instead of trying.

Also agree the **title and tags**. Tags are the whole discovery mechanism: untagged content never
appears in keyword search on either engine. Spend them like a searcher — feelings and moments
("deal with it", "you got this", "finger guns") plus the literal subject ("duck", "sunglasses").
GIPHY allows 20.

## 3. Tenor

Full click-path with the measured element behaviour: [`references/upload-flows.md`](references/upload-flows.md).

1. `tabs_create_mcp`, then `navigate` to `tenor.com/gif-maker` — not `/upload`, which 404s. If the page shows **SIGN IN**, stop and ask
   the user to sign in (a Google account chooser opens in a popup window).
2. The six `input[type=file]` are `display:none`. `find` the file input (it returns refs listed as
   "file-input ... (hidden)") and call `file_upload` on the first with the GIF path; never click a
   file input. **Measured 2026-11-14 on Claude in Chrome:** this staged the GIF (thumbnail, tag box,
   UPLOAD TO TENOR disabled until a tag). The GIF must sit in a shared path; the Claude Code session
   scratchpad qualifies. If `file_upload` fails, **stop and report to the operator**; do not
   substitute `upload_image` (it uploads only a `computer` screenshot, never the GIF).
3. Tags: the box reads "Add Tags (minimum 1)"; one text entry plus Enter per tag worked at full speed
   on the old rail (tag entry not yet measured on Claude in Chrome). Chips render upper-case; overflow shows as "+N".
4. Screenshot the staged form (`computer`), show it, **confirm**, then click **UPLOAD TO TENOR**.
5. Success lands on `/users/<name>` reading **PROCESSING UPLOAD…**, then **CONTENT PENDING
   REVIEW**. There is **no public `/view/` URL until review passes** (up to 48 h). Report that as
   pending, not as done.

## 4. GIPHY

1. `tabs_create_mcp`, then `navigate` to `giphy.com/upload`. A cookie banner may sit on top; if the page shows **Log In**, stop and ask.
2. The "Choose Files" button took the file directly on the old rail; on Claude in Chrome use
   `find` + `file_upload` (not yet measured, 2026-11-14). The page moves to `/upload/finalize`.
3. **Tags: type the text, then a separate Enter keypress, per tag** (`computer` actions). The box
   is a controlled React input; typing with Enter in the same call fifteen times in a row **kept 7
   of 15** and left the last one sitting in the box. After the batch, `read_page` and count the chips.
4. Check **Visibility** reads "Anyone can see this." Source URL and Collection are optional.
5. Show the form, **confirm**, click **Upload to GIPHY**. Success is an immediate redirect to
   `giphy.com/gifs/<tag-slug>-<id>` — that URL is the deliverable.

## 5. Report

| Field | Say |
|---|---|
| File | path, bytes, WxH, fps, seconds, "loops forever" verified |
| Tenor | **pending review** (≤48 h) — link appears on the user's profile when approved |
| GIPHY | the `/gifs/...` URL; **not in search** until Artist channel approved; N of 5 uploads toward applying |

## Human gates

- Sign-in on each site (the user, in the browser).
- A click-to-select confirmation **before each submit** — both are public and neither has an undo
  that recalls what a picker already cached.

## Pitfalls — all measured 2026-10-07

- **Bayer dither inflates the file ~10%** and **gifsicle `--lossy=100` saves ~34%**; the ladder
  in `media-gif` is ordered by those numbers.
- **A square centre-crop can be bigger than the letterboxed original at a larger width.** The
  cropped-off strips were flat background and nearly free in LZW. Do not promise that fewer
  pixels means fewer bytes; run the budget mode and read the result.
- **GIF frame delays are 10 ms quanta**: a 4.80 s request came out 4.83 s. `media-gif` targets
  97% of `--max-seconds` for that reason.
- **`tenor.com/upload` is a 404**; the uploader is `/gif-maker`.
- **Tenor's file inputs are hidden**; **GIPHY's tag box races**. See §3 and §4.
- **GIPHY search placement is not an upload setting.** It is a channel approval, and the
  application form itself is gated behind five public uploads.
- **Tenor review hides the GIF entirely** — not even the owner's profile shows a `/view/` link
  until it passes.

## References

- Tenor help, upload FAQ ("up to 48 hours for GIFs to be approved for publication"):
  <https://support.google.com/tenor/answer/10455265>
- GIPHY: *Verified on GIPHY* and *Get Your GIFs & Stickers Into GIPHY's Search*:
  <https://support.giphy.com/hc/en-us/articles/360020231651>,
  <https://support.giphy.com/hc/en-us/articles/360020233051>
- GIPHY *Tips For Submitting An Application* ("at least 5 pieces of content … set to public"):
  <https://support.giphy.com/hc/en-us/articles/360020433711>
- ffmpeg palettegen/paletteuse (the two-pass method): <https://ffmpeg.org/ffmpeg-filters.html#palettegen>
- gifsicle `--lossy`: <https://www.lcdf.org/gifsicle/man.html>
- Third-party GIPHY spec summary (480 px wide, <8 MB, ≤6 s): <https://whatthegif.com/guides/upload-gif-to-giphy>
