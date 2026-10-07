# Upload flows — Tenor and GIPHY over the Chrome DevTools Protocol

Measured 2026-10-07 with the chrome-devtools MCP against ungoogled-Chromium 152 on
`--remote-debugging-port=9222`. Tool names are the MCP's (`new_page`, `take_snapshot`,
`evaluate_script`, `upload_file`, `type_text`, `press_key`, `click`, `wait_for`). The DOM details
are the kind that change without notice; when a step fails, re-snapshot and re-measure rather
than trusting this file.

## Preflight — is the browser really driveable?

Two instruments that could disagree:

```bash
lsof -nP -iTCP:9222 -sTCP:LISTEN               # process + LISTEN
curl -fsS http://127.0.0.1:9222/json/version   # JSON with "webSocketDebuggerUrl"
```

A consent-mode browser 404s every `/json/*` route, which is why the attach script that ships the
MCP probes HTTP first and falls back to the profile's `DevToolsActivePort`. If both fail, the
browser is not in debug mode; the route to bring it up lives with that script, not here.

## Tenor

| Step | Call | Measured behaviour |
|---|---|---|
| Open | `new_page https://tenor.com/gif-maker` | `tenor.com/upload` returns a 404 page. The nav's **CREATE** link points at `/gif-maker`. |
| Sign-in check | `evaluate_script` → any `button` whose text matches /sign in/i | Signed-out shows **SIGN IN**; clicking it opens a modal with a Google button that opens `accounts.google.com/v3/signin/accountchooser` **in a new window** (it appears as a new page id). The user picks the account. Signed-in pages carry `a[href*="/users/"]`. |
| File input | `evaluate_script` listing `input[type=file]` | **Six** inputs, all `display:none`, ids `upload_file_dropzone-*`, `accept=".gif, image/gif, .mp4, video/mp4, .jpg, image/jpeg, .png"`, `multiple`. `upload_file` on the visible **Browse Files to Upload** button fails: "clicking it did not trigger a file chooser". |
| Un-hide | `evaluate_script` | `i.style.display='block'; i.style.position='fixed'; i.setAttribute('aria-label','cc-file-input')` on `#upload_file_dropzone-upload-file-section-button`, then `take_snapshot` — it now appears as a button with that label. |
| Attach | `upload_file uid=<that> filePaths=[...]` | Snapshot shows the input `disabled value="<filename>"`, then the page re-renders. |
| Wait | `wait_for ["Tags","UPLOAD TO TENOR"]` | New view: a staged image, textbox **"Add Tags (minimum 1)"** (focused), headings "Add more content" / "Edit and Tag your content", buttons **CANCEL** and **Upload Icon UPLOAD TO TENOR**. |
| Tags | `type_text text=<tag> submitKey=Enter`, repeated | Fifteen in a row all registered. Chips are upper-cased (`COOL DUCK ×`); after three the rest collapse to a **"+N"** button. The textbox relabels to "Add More Tags". |
| Submit | `click` the UPLOAD TO TENOR button | Navigates to `/users/<name>`. |
| Result | `evaluate_script` on body text | **"PROCESSING UPLOAD…"** for a few seconds, then **"CONTENT PENDING REVIEW"** with `0 shares`. No `a[href*="/view/"]` for the new GIF exists while pending. Tenor's FAQ: up to 48 h. |

Batch limit on the page: "Up to 10 GIFs, MP4s, PNGs, JPGs". The page also offers a **URL
upload** textbox ("Paste a media URL") — untested, but it would avoid the hidden-input dance
for a GIF already hosted somewhere.

## GIPHY

| Step | Call | Measured behaviour |
|---|---|---|
| Open | `new_page https://giphy.com/upload` | A cookie-consent banner ("By clicking 'Agree'…") can cover the page. Signed-out body text contains **Log In**. Signed-in shows the channel name top-left and `/channel/<name>` links. |
| File input | `take_snapshot` | Two **"Choose Files"** buttons (GIF, Sticker) plus a URL textbox. `upload_file` on the first **works directly**; the page moves to `/upload/finalize`. |
| Finalize form | snapshot | "Add Info" panel: **Visibility** button labelled "Public Private" with the text **"Anyone can see this."** when public; **Add Tags** textbox; **Source URL** textbox; **Add to Collection**; the **Upload to GIPHY** text is a static node inside the submit button. |
| Tags — the race | `click` the tag box, then **`type_text` (no submitKey) + `press_key Enter`** per tag | Controlled React input. Fifteen rapid `type_text … submitKey=Enter` calls **registered 7 of 15** (alternate ones dropped) and left the 15th in the box. The slow form — two calls per tag, which puts a round-trip between keystroke and Enter — registered all of them. Chips render as `# <tag> ␡`. **Snapshot and count** before submitting. |
| Submit | `click` the "Upload to GIPHY" node | Immediate redirect to `giphy.com/gifs/<three-tags-slug>-<id>`; the view page lists the tags as `# tag` links and the owner's channel. |
| Apply for Artist/Brand | `navigate_page https://giphy.com/apply` | Redirects to `/apply/more-gifs`: "In order to be considered for a Brand or Artist account, you must have **at least 5 GIFs** on your channel." Support article adds: for Creators, all five must be **public**. |

## Why the browser, and not an API

- Tenor's developer API is read-only for third parties (search, trending, registershare); there is
  no public upload endpoint.
- GIPHY has an Upload API, but a key is tied to an app you register and content still lands on
  the channel of the account that owns the key; it does not change the search-placement rule, and
  it adds a credential to manage for a form that takes ninety seconds to fill. Revisit if volume
  makes the form the bottleneck.
