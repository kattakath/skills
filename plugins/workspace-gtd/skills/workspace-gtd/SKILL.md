---
name: workspace-gtd
description: >
  This skill should be used when planning, reminding or organizing work and life on Google
  Workspace — "add this to my list", "remind me", "plan my week", "draft the Friday review",
  "shutdown", "what's on my plate", "set up my productivity system", "where should this
  live", "block time for X", "my employer uses Outlook/Slack", or any request to create
  tasks, calendar blocks, reminders or Studio flows. It runs GTD on Google Tasks + Calendar
  with eight Studio-native apps only (Gmail, Chat, Calendar, Tasks, Drive, Docs, Sheets,
  Forms), one home per fact, no alarms, and an employer treated as an adapter.
---

# workspace-gtd

A work-life system on **eight Google Workspace apps** — the ones Workspace Studio supports
natively: Gmail, Chat, Calendar, Tasks, Drive, Docs, Sheets, Forms. Backbone: **GTD** (David
Allen) on Tasks + Calendar, **Inbox Zero** batching for Gmail, **PARA** for Drive, Cal
Newport's **shutdown ritual** to close the day, Laura Mae Martin's **Power Hours** and
**Top 3** (Google's executive productivity advisor, *Uptime*).

The operator's specifics — list names, calendar names, key senders, employer — live **in
Google**, not here. Read them at run time (§ 1). Never write a second copy of them into a
repo, a memory file or a doc.

## 1. Discover before acting

- `list_task_lists` (Tasks) — expect the default list renamed **Inbox**, plus Work, Home,
  Waiting, Someday, one list per trip, and one **"Work – <employer>"** list.
- `list_calendars` (Calendar) — expect the primary calendar plus a read-only
  **"<employer> (busy)"** ICS subscription.
- Recurring events on the primary calendar: daily **Shutdown**, **Power Hours**, Friday
  **Weekly review**, 1st-Friday **Monthly admin**. Their descriptions hold the checklists —
  read them; they are the procedure's source of truth.
- If none of this exists, offer to set it up (§ 6) instead of improvising another layout.

## 2. One home per fact

| Fact | Home | Rule |
|---|---|---|
| Every action, work and family | **Tasks** | New item → **Inbox** list. Date only: the Tasks API drops the time |
| Waiting on someone | Tasks **Waiting** | Title starts with who, e.g. "Bank — mortgage letter" |
| When something happens | **Calendar** | Timed reminder = an event with `overrideReminders` popups (max 5). Read it back before reporting it set |
| Email | **Gmail** | Labels file mail; they never hold actions. An email needing action → Gmail's native **Add to Tasks**. Labels mirror Drive's numbered areas (`02 Finance/Bills`, `03 Career/Jobs`, `04 Travel/…`); a retired label moves under `99 Archive/` |
| Reference | **Drive**, PARA folders | Projects / Areas / Resources / Archive (numbered folders are fine). **One** archive — `99 Archive`, with area subfolders inside — never an Archive folder per area. Link sharing ("Anyone with the link") stays off; share with named people |
| Nudges | **Chat** via Studio | Never a list, never a capture point |
| Intake from other people | **Forms** → Sheet | Only when a flow genuinely needs structured input |

**Never a second copy.** No Gmail draft, Doc or Chat post that repeats a task list or an
event's plan. If two places could hold a fact, pick the one above and link to it.

## 3. No alarms

No Google app or API can create an Android alarm (Calendar, Tasks, Keep, Gemini and the
Android Management API all checked). A Calendar popup on a phone set to vibrate **only
vibrates** — measured. So the system runs on **nudges and reviews, not wake-ups**. Never build
an "alarm" out of stacked popups or a dedicated calendar; if the operator must wake for
something, say plainly that this needs the phone's clock app.

## 4. Rhythms — what the agent does in each

| Rhythm | Operator | Agent, on request |
|---|---|---|
| **Daily shutdown** (10 min, end of work) | Inbox list to zero; block tomorrow; glance at Waiting; "shutdown complete" | Propose tomorrow's blocks from Tasks + Calendar free time |
| **Weekly review** (Fri, 45 min) | Approve the **Top 3** for next week and their blocks | **Draft it first**: Inbox items with a proposed list each; stale Waiting items (>7 days) with a chase line; next 2 weeks of Calendar incl. the employer busy feed; 3–5 Top-3 candidates with free slots |
| **Monthly admin** (1st Fri, 30 min) | Invoices, bills, decisions | List renewals due in 90 days (recurring Calendar events), finished projects to archive in Drive, Someday items older than 90 days |

Drafts go in the conversation, not in a new Doc. Writes (moving tasks, creating blocks) need
the operator's yes in that review.

## 5. Employer = an adapter, not a second system

Employer tools (Outlook, Slack, Teams, Jira, …) stay the home of employer work. The personal
system holds only:

- **Calendar:** the employer calendar published as an **ICS link, free/busy only**
  (Outlook: Settings → Calendar → Shared calendars → Publish a calendar → "Can view when I'm
  busy"), subscribed in Google Calendar → *From URL*, **not public**, renamed
  "<employer> (busy)". Move the link between tabs by script; never print it — anyone with it
  reads the busy feed. Google refreshes subscriptions every few hours.
- **Tasks:** "Work – <employer>" holds **pointers only** ("Reply to X's thread in #infra"),
  never employer content.
- **Weekly review:** one step — skim the employer's chat, mail and calendar; add pointers.

**Never forward employer mail into Gmail** (most employer policies forbid it, and it copies
client data). Changing jobs = unsubscribe the old ICS, subscribe the new, rename the list,
edit the review step — nothing else changes.

## 6. Setting it up (once)

1. Tasks: rename the default list to **Inbox** (Studio's *Create a task* writes to the
   default list; confirm after renaming that it still is); create Work, Home, Waiting, Someday.
2. Calendar: recurring events — Shutdown (weekdays, end of work, 10 min), Power Hours
   (2–3 mornings a week, busy, 2 h), Weekly review (Friday, 45 min), Monthly admin (1st
   Friday, 30 min) — each with its checklist in the description and one popup.
3. Studio (studio.workspace.google.com), from Google's own templates:
   - **"Get a daily summary of unread emails"** → schedule weekdays at work start, no end
     date → Notify me in Chat.
   - **"Notify me about emails from key people"** → From = the key senders.
4. Gmail, once: archive inbox mail older than 30 days that is not starred and not labelled
   for reply (search → *Most recent* sort → select all → *Select all conversations that
   match* → Archive). Archive is reversible.
5. Phone (Android, if adb is available): Calendar, Tasks, Chat battery **Unrestricted**
   (`cmd deviceidle whitelist +<pkg>`, `cmd appops set <pkg> RUN_ANY_IN_BACKGROUND allow`),
   unused-app hibernation off (`cmd appops set <pkg> AUTO_REVOKE_PERMISSIONS_IF_UNUSED
   ignore`), and Do Not Disturb → *Alarms and sounds* → **Calendar events** and
   **Reminders** on. Without adb, the operator taps the same settings.

## 7. Workspace Studio facts (checked 2026-10)

- **Starters:** schedule, Gmail (new email; From, Has the words), Calendar, Drive, Chat,
  Forms, Sheets. **From takes addresses, not domains** — add each sender address.
- **Third-party:** Slack is a Beta connector with **actions only** (no Slack-message
  starter); **no Microsoft (Outlook/Teams) connector**. Named integrations: Asana,
  Confluence, HubSpot, Jira, Mailchimp, QuickBooks, Salesforce, Slack — admin enables them,
  off by default ([Workspace Updates, 2026-09-17](https://workspaceupdates.googleblog.com/2026/09/automate-workflows-with-custom-starters-and-steps-third-party-integrations-and-webhooks-in-Workspace-Studio.html)).
- **Limits:** 25 flows, 100 steps per flow, and an unpublished daily run cap shared by all
  flows — a chatty flow can stop every other flow until reset. Prefer native features
  (Gmail *Add to Tasks*, recurring Calendar events) over a flow that does the same job.
- **Business Starter** has no Focus time, Working location or Time Insights. Stand-ins:
  Power Hours as a busy block, Chat Do Not Disturb, the weekly review.

## Rejected — and why

| Option | Why it lost |
|---|---|
| Alarm made of stacked Calendar popups | Re-invents the clock app and still only vibrates |
| Studio flow "action email → task" | Gmail's native *Add to Tasks* does it with no run-cap risk |
| Renewals tracked in a Sheet | A second copy of dates recurring Calendar events hold |
| Keep reminders | Keep's API is admin-only and has no reminder field |
| Forwarding employer mail to Gmail | Policy breach and a copy of client data |
| Google Chat API for pings | Needs its own Chat app in Google Cloud; Studio's *Notify me in Chat* is native |
| Studio template "Label emails with action items" | Turns a label into a second action list; measured 2026-10-31: 16 of its 21 "To respond" threads were noise. *Add to Tasks* is the capture |
| Fixed-day repeating Tasks for card or bill dues | Statement due dates move, so the reminder drifts from the real date (one was 6 days early). The date lives on the dated task |
| Filters that skip the Inbox for bank notices | Hides a due date. Only receipts and utilities skip the Inbox |
