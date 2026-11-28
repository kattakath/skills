# slack-etiquette

One skill, `slack-etiquette:slack-etiquette`, that loads before any Slack message an agent sends to a person or a group.

It sits on top of Slack's own [`slack-messaging`](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/slack) skill, which covers markdown and basic structure, and adds what that skill leaves out:

| Rule | Why it exists |
|---|---|
| Before the first post, read your own profile and say which workspace and user you are | One machine can hold several workspaces' connectors; the tools look the same |
| Look people and channels up live (`slack_search_users`, `slack_search_channels`); read the topic of a channel nobody named | A hand-kept directory goes stale and is per-workspace |
| Post only to ask for action, report a live change or incident, or answer | Eight step-by-step updates to one person in one evening were judged spam; progress belongs on the PR |
| Re-read every conversation right before sending, from the last message of theirs you fully addressed | Starting from your own last send missed a bug report that arrived while composing |
| Group for FYIs, DM for asks, reply where asked, threads for follow-ups | A group of three plus two DMs otherwise gets the same news three times |
| Send each fact once, across conversations and sibling agent sessions | Two parallel sessions already drafted duplicate updates to the same person |
| First line = the point; **bold** only the action; IDs in `code` | Read on a phone, often from the notification line alone |
| Link text = part of the URL | Slack never unfurls a link "where the label is a complete substring of your URL minus the protocol" ([Slack docs](https://docs.slack.dev/messaging/unfurling-links-in-messages)); hosted MCP send tools expose `unfurl_app_links` but no switch for plain link previews |
| No hand-typed signature | Hosted Slack MCP connectors append their own "Sent using" footer; adding one doubles it |

The skill holds **no workspace data**: it resolves IDs live through the connector.

## The hook

`hooks/hooks.json` runs `scripts/send-guard.js` before every tool whose name ends in `slack_send_message`, `slack_send_message_draft` or `slack_schedule_message`, so it covers every connector prefix.

| Input | Result |
|---|---|
| Any send | A 5-line checklist as `additionalContext`, pointing at the skill |
| A link labelled with a URL (`[https://…](…)`, `<url\|https://…>`) | **Denied**: Slack would unfurl it |
| A line starting `Sent using` | **Denied**: the connector appends its own footer |
| Unparseable input, any other tool | Nothing; exit 0 (fails open) |

It keeps no state between calls. Tests: `bash plugins/slack-etiquette/tests/run.sh`.

Requires a Slack MCP (the claude.ai Slack connector, Slack's plugin, or any server exposing the `slack_*` tools) and `node` for the hook.
