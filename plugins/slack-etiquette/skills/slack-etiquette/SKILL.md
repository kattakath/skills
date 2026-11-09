---
name: slack-etiquette
description: "Use before sending, drafting, scheduling or replying to ANY Slack message to a person or group (slack_send_message, slack_send_message_draft, slack_schedule_message): choose the right conversation (group vs DM vs thread), avoid spam and duplicates across conversations and sibling agent sessions, re-read history first, and format for a human on a phone, including links that do not expand into previews. Layers team etiquette on top of Slack's own slack:slack-messaging skill."
---

# Slack etiquette for agents that message people

Agents post faster than people read. Every rule here protects a human reader's attention.
Slack's own skill `slack:slack-messaging` covers the formatting basics: lead with the point,
keep it short, use threads, write standard markdown. Read it first if it is loaded. This
skill adds what that one leaves out: **which conversation to use, when not to post at all,
and how to avoid colliding with other agents.**

## 1. Should this be a Slack message at all?

Send only when one of these holds:

- Someone must **act or decide**, and it isn't already on a PR or issue they watch.
- A **live system changed** on the operator's authority (a deploy, a host change, an access grant).
- An **incident** or blocker.
- A **direct answer** to their Slack question.

Everything else goes where the reader already works. Progress, evidence and fix lists go on
the PR or issue, which notifies them anyway. **Bundle:** one message covering everything
pending beats one per finding. On one evening, eight step-by-step messages to one person
were judged spam.

## 2. Re-read before every send

1. Read each conversation you might post in, **right before sending**. Start from the last
   message of THEIRS you fully addressed, never from your own last send, and include thread
   replies. A reply that landed while you were composing is the one you will otherwise miss.
2. List every ask or point they made since then. The new message covers each: done (with
   evidence), not yet (and why), or handed to someone (who).
3. Check whether **another agent session** has already said it. Sibling sessions share the
   same human's Slack. If a split exists (which session owns which conversation or topic),
   follow it, and forward an off-topic item to the owner instead of posting.

## 3. Pick the conversation

| Situation | Where |
|---|---|
| An update everyone in a group should know, no reply expected (an unblock, a result, a status change) | The **group** conversation |
| A question or ask that needs one person's reply | That person's **DM** |
| Answering a question | **Where it was asked**: same conversation, in its thread when it was threaded |
| A follow-up on a topic already under way | A **thread reply** on the original message, not a new top-level post |
| A group question really aimed at one person | Answer **in the group** (the asker sees it), short, tagging that person |

**Send each fact once.** Don't post the same content in a group and a DM. The one exception
is a DM carrying something only that person needs, such as their own action. It points to
the group message ("see the group update") instead of repeating it.

## 4. Write for a person on a phone

- **First line = the point**: the answer, the ask or the result. Then 2–5 bullets with what
  the reader needs to act. No preamble, no recap of your process, no internal tool names.
- **Be exact.** Give names, numbers, IDs, versions and times with the timezone. Leave out
  steps you took that don't change what they do next.
- **Formatting** (the send tools take standard markdown):
  - `**bold**` for the ONE thing to act on. A single `*x*` renders italic. If everything is
    bold, nothing stands out.
  - `` `code` `` for IDs, branches, commits, commands and paths.
  - A fenced code block for multi-line output or a command to run.
  - `>` to quote the line you are answering.
  - A list for 3 or more parallel items.
- **For an ask, tag the person and name the exact decision**, with options when it's a choice.
  Use the `<@USERID>` mention syntax and look up the ID; never guess it. In a group, tag only
  the person the ask is for.
- **No signature.** Hosted Slack MCP connectors append their own "Sent using …" footer; adding
  one yourself doubles it.

## 5. Links without previews

Previews push the message down and repeat what the text already says.

- **Make the link text part of the URL.** Slack never expands a link "where the label is a
  complete substring of your URL minus the protocol" ([Slack docs, Unfurling links](https://docs.slack.dev/messaging/unfurling-links-in-messages)).
  So write `[github.com/acme/app/pull/42](https://github.com/acme/app/pull/42)`, not
  `[the PR](https://github.com/acme/app/pull/42)`. A tail of the URL also counts (any
  complete substring), e.g. `[app/pull/42](https://github.com/acme/app/pull/42)`.
- **Leave app previews off.** On a tool that offers `unfurl_app_links` (GitHub, Jira and
  similar installed apps), leave it unset or `false` unless the preview IS the point.
- **Check the first message that carries a link.** Markdown is converted on send, so
  read the message back once to confirm the link text survived as written.

## 6. Unreviewed messages

If the operator asked to review messages first, or the message speaks for them on something
new (a commitment, a date, a decision), send a draft (`slack_send_message_draft`) and let
them post it. Routine replies inside an agreed flow can go out directly.

## Where the directory lives

This skill holds no workspace data. Who is who, user IDs, conversation IDs and which session
owns which conversation belong to the workspace's own context: a project or folder
`CLAUDE.md`, or the operator's memory. Look them up there before tagging or choosing a
conversation.
