# workspace-gtd

GTD (Getting Things Done) on Google Tasks + Calendar, using only the eight Google Workspace apps
that Workspace Studio supports natively: Gmail, Chat, Calendar, Tasks, Drive, Docs, Sheets
and Forms. One skill, `workspace-gtd:workspace-gtd`.

## What it ships

- **One home per fact.**
  - Tasks holds every action (Inbox, Work, Home, Waiting, Someday).
  - Calendar holds every *when*.
  - Gmail labels only file mail.
  - Drive is laid out as PARA (Projects, Areas, Resources, Archives).
  - Chat only nudges.
- **Rhythms the agent supports:**
  - a 10-minute daily shutdown (Cal Newport);
  - a 45-minute Friday review that the agent drafts and the operator approves (GTD weekly review plus Laura Mae Martin's *Top 3*);
  - 30 minutes of monthly admin.
- **Employer as an adapter.** Outlook, Slack or Teams joins through two things only: a free/busy ICS subscription and a Tasks list of pointers. Changing jobs means swapping that adapter, not rebuilding the system.
- **A setup recipe:** Tasks lists, recurring Calendar blocks, Google's own Studio templates (daily unread recap, key people → Chat), a one-time inbox archive, and Android battery and Do Not Disturb settings over adb.

## Facts it exists to carry (checked October 2026)

| Fact | Evidence |
|---|---|
| No Google app or API can set an Android alarm | Calendar, Tasks, Keep, Gemini and Android Management API docs. A Calendar popup on a phone in vibrate mode only vibrates (tested) |
| Studio's Gmail starter *From* field takes addresses, not domains | Studio editor |
| Slack is an action-only Beta connector. There is no Microsoft connector | [Workspace Updates, 2026-09-17](https://workspaceupdates.googleblog.com/2026/09/automate-workflows-with-custom-starters-and-steps-third-party-integrations-and-webhooks-in-Workspace-Studio.html) |
| Business Starter has no Focus time, Working location or Time Insights | Google Workspace edition docs |

## What it deliberately leaves out

- **Alarms.** Covered above: no Google app can set one.
- **A Studio flow for action emails.** Gmail's own *Add to Tasks* button does the job.
- **Renewal-tracking Sheets.** Recurring Calendar events already hold renewal dates.
- **Keep.** Out of scope: only the eight Studio-native apps are used.
- **Forwarding employer mail into Gmail.** Employer mail stays with the employer.

## Requires

- **A Google Workspace account and the operator's data.** The skill reads list names, calendars and key senders from Google at run time, so this repo holds none of them.
- **Connectors:** the Google Calendar, Gmail and Drive connectors, plus a Google Tasks MCP server.
- **Browser automation**, for Studio and settings pages that have no API.
- **Optional:** adb, for the phone settings.
