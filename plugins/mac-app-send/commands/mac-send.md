---
name: mac-send
description: Send a formatted message and optional file attachments through a native macOS app (WhatsApp, Messages) using computer-use, with the footguns pre-empted.
---

Send through a native Mac app. `$ARGUMENTS` names the app, the recipient and what to send.

Follow the **mac-app-send** skill for the method. This command exists to pin the order and
the two verification points, which is where sends go wrong.

## 1. Preflight

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/mac-app-doctor.sh" <App>
```

If files are going too, get their facts now — you will need them to verify the send:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/file-manifest.sh" <file>...
```

## 2. Confirm the recipient — before any keystroke

Screenshot and read the conversation header. A 1:1 reads "Click for contact info"; a group
names its members. **Sending a personal document to a group cannot be undone.** If it is
ambiguous, ask.

## 3. Compose and verify the draft

Build the whole message as one string with real newlines, then:

- `app_ax_find role=AXTextArea` → note the `[N]`
- `app_type element_index=N mode=replace` → confirm it reports **"set AXValue (whole-field replace)"**
- **Screenshot the draft and read it back** before sending

Never type a multi-line message at a coordinate — the plugin's guard blocks that, because
Enter sends and the message would arrive one bubble per line.

## 4. Attachments

Go straight to `request_full_control` when the chooser opens. Inside it: **List view first**,
`⌘A` before typing a path into Go-to-Folder, `⌘`-click for multi-select, and **zoom to read
the filenames before pressing Open**.

## 5. Verify the send against disk

Read the sent bubbles and match **filename, page count and KB** to the manifest from step 1.
The preview carousel can label one file while showing another — the sent bubble is the truth.

Report what was sent with those numbers, then `release_full_control` and `app_release`.
