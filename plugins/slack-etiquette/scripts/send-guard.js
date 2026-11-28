#!/usr/bin/env node
// PreToolUse guard for Slack send tools, whichever connector serves them (the tool name
// is matched on its SUFFIX: mcp__<any>__slack_send_message and friends).
// - Always: a short checklist as additionalContext, pointing at the skill.
// - Deny only what the tool input itself proves wrong:
//     (a) a link whose label is itself a URL -> Slack unfurls it into a preview
//     (b) a hand-typed "Sent using" footer   -> the connector appends its own, so it doubles
// - Fails OPEN: unparseable input or an unknown tool prints nothing and exits 0.
// No state is kept between calls.
"use strict";

const SUFFIX = /__slack_(send_message|send_message_draft|schedule_message)$/;

const CHECKLIST = [
  "slack-etiquette (skill slack-etiquette:slack-etiquette) before this send:",
  "- Signed-in workspace/user confirmed this session (slack_read_user_profile)?",
  "- Re-read the conversation + threads since their last message you fully addressed?",
  "- Right place (group FYI / DM ask / reply where asked / thread follow-up), each fact once?",
  "- First line = the point; links labelled with part of the URL; no signature.",
].join("\n");

// [label](url) markdown links and <url|label> Slack mrkdwn links.
const MD_LINK = /\[([^\]\n]+)\]\((\S+?)\)/g;
const MRKDWN_LINK = /<(https?:\/\/[^|>\s]+)\|([^>\n]+)>/g;
const URL_LABEL = /^\s*(https?:\/\/|www\.)/i;
const FOOTER = /^[\s>*_~]*sent using\b/im;

function texts(input) {
  if (!input || typeof input !== "object") return [];
  return ["message", "text", "draft_message", "content"]
    .map((k) => input[k])
    .filter((v) => typeof v === "string");
}

function defects(body) {
  const found = [];
  for (const m of body.matchAll(MD_LINK)) {
    if (URL_LABEL.test(m[1])) found.push(`link label is a URL and will unfurl: [${m[1]}](...)`);
  }
  for (const m of body.matchAll(MRKDWN_LINK)) {
    if (URL_LABEL.test(m[2])) found.push(`link label is a URL and will unfurl: <...|${m[2]}>`);
  }
  if (FOOTER.test(body)) found.push('hand-typed "Sent using" footer: the connector appends its own, so it would appear twice');
  return found;
}

function main(raw) {
  let ev;
  try { ev = JSON.parse(raw); } catch { return; }
  if (!ev || typeof ev.tool_name !== "string" || !SUFFIX.test(ev.tool_name)) return;

  const found = texts(ev.tool_input).flatMap(defects);
  const out = { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: CHECKLIST } };
  if (found.length) {
    out.hookSpecificOutput.permissionDecision = "deny";
    out.hookSpecificOutput.permissionDecisionReason =
      "slack-etiquette: fix before sending —\n- " + found.join("\n- ") +
      "\nLabel links with part of the URL minus the protocol (e.g. [github.com/o/r/pull/1](https://github.com/o/r/pull/1)); drop any signature.";
  }
  process.stdout.write(JSON.stringify(out));
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { buf += c; });
process.stdin.on("end", () => {
  try { main(buf); } catch { /* fail open */ }
  process.exit(0);
});
