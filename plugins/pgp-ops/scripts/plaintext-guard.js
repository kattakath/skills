#!/usr/bin/env node
/**
 * plaintext-guard.js — a PreToolUse gate that keeps DECRYPTED text away from the AI.
 *
 * The rule it enforces (the operator's, stated as "strictly"): a decrypted message
 * goes to the clipboard ONLY. It is never printed into the transcript and never read
 * by the model — not even when asked. pgp-ops already routes every decrypt through
 * scripts/gpg-in-window.zsh, which runs in a separate terminal window and writes
 * only lengths and flags. This hook closes the agent's own shortcuts around that:
 *
 *   1. gpg / gpg2 / gpgtar that DECRYPTS in the agent's shell — `-d`, `--decrypt*`,
 *      a short-option cluster containing `d`, and a gpg call with NO explicit
 *      command, whose default action on an encrypted file is to decrypt it and
 *      write the plaintext next to it (measured 2026-10-17: `gpg m.asc` printed
 *      nothing and created `m`).
 *   2. Reading the clipboard where the result can reach the model: `pbpaste` is
 *      allowed ONLY when piped straight into a sink that emits a count or a digest
 *      (wc, shasum, sha*sum, md5, openssl dgst, cmp) or back into pbcopy, or into a
 *      gpg stage that can only produce ciphertext or key metadata. Everything else —
 *      bare, redirected to a file, captured in $(…), piped to head/grep/base64 — is
 *      refused, because after a decrypt the clipboard IS the plaintext.
 *   3. Other clipboard readers: osascript mentioning the clipboard (except
 *      `set the clipboard to`), NSPasteboard, pyperclip, xclip/xsel -o, wl-paste,
 *      and the computer-use `read_clipboard` tool.
 *
 * Measured safe, so NOT blocked: `gpg --list-packets` (even -vv) and `gpg --verify`
 * printed no plaintext from a canary message on GnuPG 2.5.24.
 *
 * LIMITS, said plainly: this reads command TEXT. A script the agent writes to a file
 * and then runs is opaque to it, as is any tool this hook is not registered on. It is
 * the mechanical floor under the skill's rule, not a sandbox.
 *
 * FAIL OPEN, LOUDLY — the same trade the fleet's other guards make. A throw that
 * denied would stall EVERY Bash call in EVERY session that has the plugin enabled;
 * so an internal error approves, with a systemMessage saying the guard is down.
 * tests/guard-cases.sh is what keeps that path from ever being the normal one.
 */
"use strict";

// A command word: start of text, or after a shell separator or an opening quote,
// optionally behind wrappers that pass their argv through.
const CMD_POS = String.raw`(?:^|[;&|(\x60'"]|\n|\$\()\s*(?:(?:sudo|env|timeout|nice|command|builtin|noglob|stdbuf|nohup|time|xargs)\s+(?:-\S+\s+|\S+=\S+\s+|\d+[smhd]?\s+)*)*`;
// The rest of one pipeline stage: up to the next separator (quotes are NOT a stop,
// so a quoted argument cannot cut a stage short and hide a later flag).
const STAGE = String.raw`[^;&|\n\x60)]*`;

const GPG_RE = new RegExp(`${CMD_POS}(?:\\S*/)?(gpg2?|gpgtar)(?=\\s|$)(${STAGE})`, "g");

// gpg commands that are NOT a decrypt. A gpg call with none of these is refused:
// its default action on encrypted input is to decrypt and write plaintext to disk.
const GPG_COMMANDS = new Set([
  "--encrypt", "--sign", "--clearsign", "--clear-sign", "--detach-sign", "--symmetric", "--store",
  "--list-keys", "--list-public-keys", "--list-secret-keys", "--list-sigs", "--check-sigs",
  "--check-signatures", "--list-signatures", "--fingerprint", "--list-packets", "--show-keys",
  "--import", "--export", "--export-secret-keys", "--export-secret-subkeys", "--export-ssh-key",
  "--verify", "--verify-files", "--quick-generate-key", "--quick-gen-key", "--quick-add-key",
  "--quick-add-uid", "--quick-revoke-uid", "--quick-set-expire", "--quick-sign-key",
  "--quick-lsign-key", "--quick-revoke-sig", "--quick-set-primary-uid", "--gen-key",
  "--generate-key", "--full-gen-key", "--full-generate-key", "--gen-revoke",
  "--generate-revocation", "--edit-key", "--sign-key", "--lsign-key", "--delete-keys",
  "--delete-key", "--delete-secret-keys", "--delete-secret-and-public-key", "--recv-keys",
  "--receive-keys", "--send-keys", "--search-keys", "--refresh-keys", "--locate-keys",
  "--locate-external-keys", "--fetch-keys", "--dearmor", "--dearmour", "--enarmor", "--enarmour",
  "--print-md", "--print-mds", "--gen-random", "--version", "--help", "--warranty",
  "--dump-options", "--list-config", "--card-status", "--card-edit", "--edit-card",
  "--change-pin", "--update-trustdb", "--check-trustdb", "--export-ownertrust",
  "--import-ownertrust", "--tofu-policy", "--list-gcrypt-config", "--gpgconf-list",
  "--gpgconf-test",
  // gpgtar
  "--create", "--list-archive", "--list",
]);
const SHORT_COMMANDS = new Set(["e", "s", "b", "c", "k", "K", "h", "t"]);

// What a gpg stage fed BY pbpaste may do: produce ciphertext or key metadata only.
// (--enarmor, --store, --clearsign and sign-only all carry the input readably.)
const GPG_PIPE_SAFE = new Set(["--encrypt", "--list-packets", "--show-keys", "--import", "--dearmor", "--dearmour"]);
const SINKS = /^(?:wc|shasum|sha1sum|sha224sum|sha256sum|sha384sum|sha512sum|md5|md5sum|cmp|pbcopy|openssl)$/;

function tokens(stage) {
  return stage
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^['"]+|['"]+$/g, ""))
    .filter(Boolean);
}

// Classify one gpg stage: { decrypt: bool, commands: Set }
function classifyGpg(argv) {
  const commands = new Set();
  let decrypt = false;
  for (const t of argv) {
    if (t === "--") break;
    if (t.startsWith("--")) {
      const name = t.split("=")[0];
      if (name === "--decrypt" || name.startsWith("--decrypt-") || name === "--multifile") decrypt = true;
      else if (GPG_COMMANDS.has(name)) commands.add(name);
    } else if (/^-[A-Za-z]+$/.test(t)) {
      for (const ch of t.slice(1)) {
        if (ch === "d") decrypt = true;
        if (SHORT_COMMANDS.has(ch)) commands.add(ch === "e" ? "--encrypt" : `-${ch}`);
      }
    }
  }
  return { decrypt, commands };
}

function checkGpg(cmd) {
  GPG_RE.lastIndex = 0;
  let m;
  while ((m = GPG_RE.exec(cmd)) !== null) {
    const { decrypt, commands } = classifyGpg(tokens(m[2]));
    if (decrypt) {
      return `\`${m[1]}\` would DECRYPT in the agent's own shell, putting plaintext where the model can read it`;
    }
    if (commands.size === 0) {
      return `\`${m[1]}\` with no explicit command defaults to decrypting its input and writing the plaintext to disk`;
    }
  }
  return null;
}

function checkPbpaste(cmd) {
  const re = /\bpbpaste\b/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    const rest = cmd.slice(m.index + m[0].length);
    // Optional pbpaste flags, then a single pipe (not ||), then the next command.
    const pipe = /^(?:\s+-\S+(?:\s+\S+)?)*\s*\|(?!\|)\s*([^;&|\n\x60)]*)/.exec(rest);
    if (!pipe) {
      return "`pbpaste` output would reach the model (not piped into a count/digest sink); after a decrypt the clipboard IS the plaintext";
    }
    const argv = tokens(pipe[1]);
    const sink = (argv[0] || "").split("/").pop();
    if (sink === "gpg" || sink === "gpg2") {
      const { decrypt, commands } = classifyGpg(argv.slice(1));
      const onlySafe = !decrypt && commands.size > 0 && [...commands].every((c) => GPG_PIPE_SAFE.has(c));
      if (!onlySafe) {
        return "`pbpaste | gpg …` may only encrypt, list packets, show/import keys or dearmor — anything else can carry clipboard plaintext to the model";
      }
      continue;
    }
    if (!SINKS.test(sink)) {
      return `\`pbpaste | ${sink || "?"}\` would show clipboard content to the model; only wc / shasum / sha*sum / md5 / openssl dgst / cmp / pbcopy are allowed sinks`;
    }
    if (sink === "openssl" && argv[1] !== "dgst") {
      return "`pbpaste | openssl` is allowed only as `openssl dgst` (a digest)";
    }
  }
  return null;
}

function checkOtherReaders(cmd) {
  if (/\bosascript\b/i.test(cmd) && /clipboard/i.test(cmd.replace(/set\s+the\s+clipboard\s+to/gi, ""))) {
    return "osascript reading the clipboard would show its content to the model";
  }
  if (/\bNSPasteboard\b|\bpyperclip\b|\bUIPasteboard\b|\bwl-paste\b/.test(cmd)) {
    return "a programmatic clipboard read would show its content to the model";
  }
  if (/\bxclip\b[^;&|\n]*\s-o\b|\bxsel\b[^;&|\n]*\s(?:-o|--output)\b/.test(cmd)) {
    return "xclip/xsel output mode reads the clipboard";
  }
  return null;
}

function checkFlat(cmd) {
  return checkGpg(cmd) || checkPbpaste(cmd) || checkOtherReaders(cmd);
}

// Command substitutions are commands too, and their flags are NOT the outer
// command's: in `gpg --homedir "$(mktemp -d)" --list-packets` the `-d` is
// mktemp's. So check each innermost $(…) / `…` on its own, then replace it with a
// placeholder and carry on with the outer text.
function check(cmd) {
  let s = cmd;
  const re = /\$\(([^()]*)\)|\x60([^\x60]*)\x60/;
  for (let i = 0, m; i < 100 && (m = re.exec(s)); i++) {
    const inner = m[1] !== undefined ? m[1] : m[2];
    const r = checkFlat(inner);
    if (r) return r;
    s = s.slice(0, m.index) + "__SUBST__" + s.slice(m.index + m[0].length);
  }
  return checkFlat(s);
}

function allow(systemMessage) {
  const out = systemMessage ? { decision: "approve", systemMessage } : { decision: "approve" };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

function block(reason) {
  const msg =
    `pgp-ops plaintext guard: refused — ${reason}. Decrypted text goes to the clipboard ONLY and is never ` +
    "printed or read by the AI, even on request. Decrypt with pgp-ops' scripts/gpg-in-window.zsh (it reports " +
    "lengths and flags, never content); verify the clipboard only with `pbpaste | wc -c` or a digest.";
  process.stdout.write(JSON.stringify({ decision: "block", reason: msg, systemMessage: msg }));
  process.exit(0);
}

if (require.main === module) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => {
    raw += c;
  });
  process.stdin.on("end", () => {
    try {
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        allow(); // unparseable input is not a reason to strand the session
      }
      const tool = String((payload && payload.tool_name) || "");
      const input = (payload && payload.tool_input) || {};

      if (/read_clipboard$/.test(tool)) {
        block("reading the clipboard through computer-use would show it to the model");
      }
      let cmd = "";
      if (tool === "Bash") cmd = String(input.command || "");
      else if (/desktop-commander__(?:start_process|interact_with_process)$/.test(tool)) {
        cmd = String(input.command || input.input || "");
      } else allow();

      const reason = cmd.trim() ? check(cmd) : null;
      if (reason) block(reason);
      allow();
    } catch (e) {
      allow(`pgp-ops plaintext guard ERRORED and let this call through: ${e && e.message}`);
    }
  });
}

module.exports = { check };
