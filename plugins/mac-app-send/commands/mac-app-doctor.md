---
name: mac-app-doctor
description: Preflight a macOS app before driving it with computer-use — resolves bundle id, install path and running state in one shot, and states what the attachment step will need.
---

Run the preflight, then report what it found and what you will do next.

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/mac-app-doctor.sh" $ARGUMENTS
```

If no app was named, ask which app — do not guess.

Read the output as fact; it is metadata, not inference. Specifically:

- **`installed : NO`** — stop and resolve the real name with `list_apps` before anything else.
- **`bundle id`** — use this exact string for `request_access` and every `app_*` call.
- **`running : no`** — `open_application` first; in background mode this does not steal focus.

Then state, in one line each, the two things that always apply:

1. You will confirm the correct conversation or window **before** the first keystroke.
2. Attachments will need **display scope** — the file chooser is a separate process.
