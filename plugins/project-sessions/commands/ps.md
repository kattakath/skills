---
description: "Hand a task to this repo's project session (SendMessage), then relay its reply"
argument-hint: "<task, in one or more sentences>"
---

# Hand this task to the repo's project session

**Task (verbatim — send it as given, do not do it here):**

$ARGUMENTS

The user typed `/ps`, so the handover is decided. Do **not** start the task in this session.

1. **Find the name.** Use the session the project-sessions context line names. If there is
   no line, run `"${CLAUDE_PLUGIN_ROOT}/bin/project-session" ensure` and use the name it
   prints. If it fails, report its reason and stop.
2. **Send it** with **SendMessage**, `to: "<name>"` (the bare name). Write it so it stands
   alone: the task above verbatim, then the repo root, what done means, and "reply to me
   with SendMessage when done".
3. **Tell the user** in one line that it was handed to `<name>`, then wait. Relay the reply
   when it arrives. If a delivery notice says the message was held or refused, say so; do
   not resend.

The `project-sessions` skill holds the details (duplicates, untrusted folders, plan mode).
