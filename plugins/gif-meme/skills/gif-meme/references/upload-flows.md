# Upload flows — Tenor and GIPHY through Claude in Chrome

**Status (2026-11-14): the Claude in Chrome route is NOT YET MEASURED.** The site behaviour below
(hidden inputs, the racing tag box, the review delay, the GIPHY gate) was measured 2026-10-07
with a CDP-driven Chromium and is a fact about the sites. Every Claude in Chrome tool call in the
tables is the intended replacement, unverified. Tools (prefix `mcp__claude-in-chrome__`, deferred,
load them in one ToolSearch call): `tabs_context_mcp`, `tabs_create_mcp`, `navigate`, `find`,
`read_page`, `file_upload`, `javascript_tool`, `computer`, `form_input`,
`read_console_messages`. The DOM details change without notice; when a step fails, re-read the page
(`read_page`) and re-measure rather than trusting this file.

## File rail rules (`file_upload`)

- It accepts only paths the user shared with the session (attachments, the session's
  outputs/uploads folders, or folders the user has connected), at most **10 MB per call**.
- It targets a `read_page`/`find` ref; file inputs must not be clicked.
- So: write the encoded GIF into a shared/connected folder (or ask the operator to share the
  file) and keep it **<= 10 MB**.

## Preflight — is the browser really driveable?

`tabs_context_mcp` returns the user's tab group when Claude in Chrome is connected. Work in a new
tab (`tabs_create_mcp`), never the user's own. A per-site permission wall is the operator's to
grant: ask, and do not reach for another browser.

**Old CDP-only trick, and its replacement.** The CDP rail set files on a hidden input directly
(`DOM.setFileInputFiles` behind `upload_file`), which is why un-hiding mattered. On Claude in
Chrome the replacement is `file_upload` on the ref `find` returns for the input. **Unverified:**
whether `find` returns refs for `display:none` inputs, and whether `file_upload` accepts one. If
not, un-hide with `javascript_tool` as in the Tenor table, then `find` again.

## Tenor

| Step | Call | Measured behaviour |
|---|---|---|
| Open | `tabs_create_mcp`, `navigate https://tenor.com/gif-maker` | `tenor.com/upload` returns a 404 page. The nav's **CREATE** link points at `/gif-maker`. |
| Sign-in check | `javascript_tool` (or `find`) → any `button` whose text matches /sign in/i | Signed-out shows **SIGN IN**; clicking it opens a modal with a Google button that opens `accounts.google.com/v3/signin/accountchooser` **in a new window** (it appears as a new page id). The user picks the account. Signed-in pages carry `a[href*="/users/"]`. |
| File input | `javascript_tool` listing `input[type=file]` | **Six** inputs, all `display:none`, ids `upload_file_dropzone-*`, `accept=".gif, image/gif, .mp4, video/mp4, .jpg, image/jpeg, .png"`, `multiple`. On the CDP rail, attaching to the visible **Browse Files to Upload** button failed: "clicking it did not trigger a file chooser". Claude in Chrome: not yet measured. |
| Un-hide (fallback) | `javascript_tool` | `i.style.display='block'; i.style.position='fixed'; i.setAttribute('aria-label','cc-file-input')` on `#upload_file_dropzone-upload-file-section-button`, then `find` it. Needed on the CDP rail; whether Claude in Chrome needs it is unmeasured. |
| Attach | `file_upload` on the ref from `find`; if it fails, stop and report (`upload_image` cannot upload the GIF) | Not yet measured on Claude in Chrome. On the CDP rail the page showed the input `disabled value="<filename>"`, then the page re-renders. |
| Wait | `read_page` until "Tags" and "UPLOAD TO TENOR" appear | New view: a staged image, textbox **"Add Tags (minimum 1)"** (focused), headings "Add more content" / "Edit and Tag your content", buttons **CANCEL** and **Upload Icon UPLOAD TO TENOR**. |
| Tags | `computer` type + Enter per tag (unmeasured; CDP: `type_text submitKey=Enter`) | Fifteen in a row all registered. Chips are upper-cased (`COOL DUCK ×`); after three the rest collapse to a **"+N"** button. The textbox relabels to "Add More Tags". |
| Submit | `computer` click the UPLOAD TO TENOR button | Navigates to `/users/<name>`. |
| Result | `read_page` / `javascript_tool` on body text | **"PROCESSING UPLOAD…"** for a few seconds, then **"CONTENT PENDING REVIEW"** with `0 shares`. No `a[href*="/view/"]` for the new GIF exists while pending. Tenor's FAQ: up to 48 h. |

Batch limit on the page: "Up to 10 GIFs, MP4s, PNGs, JPGs". The page also offers a **URL
upload** textbox ("Paste a media URL") — untested, but it would avoid the hidden-input dance
for a GIF already hosted somewhere.

## GIPHY

| Step | Call | Measured behaviour |
|---|---|---|
| Open | `tabs_create_mcp`, `navigate https://giphy.com/upload` | A cookie-consent banner ("By clicking 'Agree'…") can cover the page. Signed-out body text contains **Log In**. Signed-in shows the channel name top-left and `/channel/<name>` links. |
| File input | `read_page` / `find` | Two **"Choose Files"** buttons (GIF, Sticker) plus a URL textbox. On the CDP rail, `upload_file` on the first **worked directly**; the page moves to `/upload/finalize`. Claude in Chrome (`find` + `file_upload`): not yet measured. |
| Finalize form | `read_page` | "Add Info" panel: **Visibility** button labelled "Public Private" with the text **"Anyone can see this."** when public; **Add Tags** textbox; **Source URL** textbox; **Add to Collection**; the **Upload to GIPHY** text is a static node inside the submit button. |
| Tags — the race | click the tag box, then **type the text, then a separate Enter keypress** per tag (`computer`) | Controlled React input. Fifteen rapid type-with-Enter calls **registered 7 of 15** (alternate ones dropped) and left the 15th in the box. The slow form — two calls per tag, which puts a round-trip between keystroke and Enter — registered all of them. Chips render as `# <tag> ␡`. **Read the page and count** the chips before submitting. (Race measured on CDP; unmeasured on Claude in Chrome.) |
| Submit | `computer` click the "Upload to GIPHY" node | Immediate redirect to `giphy.com/gifs/<three-tags-slug>-<id>`; the view page lists the tags as `# tag` links and the owner's channel. |
| Apply for Artist/Brand | `navigate https://giphy.com/apply` | Redirects to `/apply/more-gifs`: "In order to be considered for a Brand or Artist account, you must have **at least 5 GIFs** on your channel." Support article adds: for Creators, all five must be **public**. |

## Why the browser, and not an API

- Tenor's developer API is read-only for third parties (search, trending, registershare); there is
  no public upload endpoint.
- GIPHY has an Upload API, but a key is tied to an app you register and content still lands on
  the channel of the account that owns the key; it does not change the search-placement rule, and
  it adds a credential to manage for a form that takes ninety seconds to fill. Revisit if volume
  makes the form the bottleneck.
