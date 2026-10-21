# Publishing to Greasy Fork — the rulebook, and the two rules that surprise people

Sharing a script is the point of writing one. Everything here is from Greasy Fork's own
[Code rules](https://greasyfork.org/en/help/code-rules) — **fetched 2026-09-06**. Sleazy Fork
runs the same codebase and the same rule set, differing only in the site name and one
adult-content line, so **"publishable" needs no per-site variant**.

Publishing is the **operator's** move: the account and its sign-in are theirs. An agent can drive
the admin pages only through a browser the operator has already signed in to. It never signs in,
and never chooses which account a script goes to.

## The metadata contract

`scripts/userscript-meta-lint.sh` mechanises this table. Nothing here is a house style; each
row is a rule Greasy Fork enforces or a failure it causes.

| Key | Why |
|---|---|
| `@name` | Required. |
| `@namespace` | Required, and what keeps two authors' identically-named scripts apart. |
| `@version` | Required, and must be **orderable** — Greasy Fork rejects a version it cannot sort, and **ignores a re-upload that does not increment**. Plain dotted-numeric (`2.0.1`). Violentmonkey's own grammar allows `1.2a.3`; do not copy that example. |
| `@description` | Required by the Functionality rule: *"Users must know what a script will do before installing it."* A script may not do things "unreasonably outside" it. |
| `@license` | How Greasy Fork resolves copyright. Omit it and **OpenUserJS silently implies MIT on your behalf** — a licence you did not choose. |
| `@match` | Required, and **only for sites the script actually serves**: *"Scripts may not include `@include`s or `@match`es for sites they do not provide functionality on."* |
| `@homepageURL` / `@supportURL` | Give a published script somewhere to send a bug that is not your DMs. |
| `@antifeature` | **Mandatory** if the script contains anything for the *author's* benefit — tracking, ads, miners. Allowed, but only if [declared](https://greasyfork.org/en/help/antifeatures). Undeclared is a removal. |

### `@antifeature` — the exact value set

Six values, and only six: **`ads`** · **`membership`** · **`miner`** · **`payment`** ·
**`referral-link`** · **`tracking`**. A value outside the set does not declare anything.

Three carve-outs that stop over-declaring, which is its own kind of wrong label:

- Promoting **your own** repo, Discord or homepage is **not** `ads`.
- A script for a site that **itself** requires payment is not `payment` — the key is about the
  *script* charging, not the site.
- `referral-link` covers **commission coupon codes**, not only URLs.

`membership` and `payment` are for a script gated behind your paid tier or purchase.

### Banned outright

`@downloadURL`, `@updateURL`, `@installURL`. Greasy Fork **strips them on upload** and forbids
"alternate download URLs, with the intent of having users use the alternate sources"; it also
notes that "most user script managers will handle automatic updates, so doing it in the script
is unnecessary". Pointed at your own repo they let a push to the default branch mutate an
installed script with no review.

## The `@require` tension — real, and resolved

This is the one place a careful author collides with the rules, so read it before assuming
either side.

> **Greasy Fork:** *"Libraries that a script uses should be `@require`-d, unless there's a valid
> technical reason not to do so. In the case that a library is included inline, it must include
> information as to the source of the library (e.g. a comment indicating URL and/or name and
> version)."*

So Greasy Fork **prefers** `@require` — while this skill's hard rule 1 **bans** it. Both hold:

- **The ban has a valid technical reason**, which is exactly the exemption the rule grants: a
  `@require` is fetched **at install time**, there is **no SRI or integrity field** in the
  userscript metadata spec, and nothing pins the fetched bytes. That is an unpinnable supply
  chain in a file that runs on every page it matches.
- **The rule's own inline path is the answer.** Vendoring is sanctioned — *provided* the
  vendored block carries **name / version / URL**. The lint enforces that: a `vendored` marker
  or a `/*! … */` banner with no source URL within five lines fails.

Do **not** vendor by minifying. "Code posted to Greasy Fork must not be obfuscated or minified…
If the script is bundled by a tool such as webpack, it must be output in non-minified form,
with whitespace and variable names retained." Greasy Fork's own heuristic is a single line
**over 5000 characters containing `function`**; the bundled lint is stricter (500 chars), so a
file that passes the lint cannot trip the site's check.

### The four legal `@require` routes — know them, then don't use them

Hard rule 1 bans CDN `@require` outright, for a reason Greasy Fork's rules do not address: the
userscript metadata spec has **no integrity field**, so nothing pins the bytes a user installs.
These four exist so a *shelf* script's `@require` line can be read correctly, and so "Greasy
Fork accepted it" is never mistaken for "the bytes are pinned".

1. **An allowlisted CDN** — the list at <https://greasyfork.org/en/help/cdns> (~65 regex
   entries). jsDelivr is conditional: `/gh/` paths must be pinned to a **40-hex commit**, `/npm/`
   paths to an exact **version**.
2. **Any URL carrying a Tampermonkey-format SRI fragment** — `#sha256=…` or `#md5=…`, `,`- or
   `;`-separated, `=` or `-` as the separator. This is an **allowlist bypass**, not a guarantee:
   the hash is enforced by **Tampermonkey only** ([`gm-api.md`](gm-api.md) § SRI).
3. **A Greasy Fork Library** — hosted on the site itself, so it is reviewable like any script.
4. **A host that equals, or is a subdomain of, every one of the script's `@match` domains** —
   the undocumented origin-host allowance. It is narrow by construction: one non-matching
   `@match` disqualifies the whole `@require`.

Hard blocks regardless of route: a `data:` `@require` containing `;base64,` is **rejected
outright**. `@resource` is protocol-checked only (`http`, `https`, `data`, protocol-relative
`//`) — no allowlist, no hash, which is why hard rule 1 covers it too.

## Other rules worth knowing before upload

| Rule | Practical effect |
|---|---|
| **2 MB limit**, and you may **not** minify to fit | Move data URIs / JSON out of the script; `@require` a genuine library or vendor it readably. |
| **Primary functionality must be in the code on Greasy Fork** | A stub that loads the real script from elsewhere is not allowed. |
| **No self-update checks more than once/day** | The manager already does this; don't write it. |
| **Adult content must be marked** | Scripts for adult sites — or containing adult content — must be flagged so others can opt out. In practice these land on **Sleazy Fork**. |
| **No unrelated keywords** in name/description | Keyword-stuffing for search placement is a removal. |
| **No reposts** of a script already on Greasy Fork | Unless yours genuinely improves on the original — another reason step 0's shelf check comes first. |
| **Respect copyright** | Vendored code keeps its own licence; check it against your `@license`. |

## Make `git push` the release — without `@updateURL`

Greasy Fork can pull from a raw URL on its own admin page. This is **not** the banned keys:
those live *inside the file* and let a push mutate an installed copy with no review. Sync is a
**site-side setting** — the file stays clean, and users still update *from Greasy Fork*, which
is exactly the norm the ban protects.

| Field | Value |
|---|---|
| Sync source | the **raw** URL — `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>.user.js` |
| Not | the GitHub *file page* URL — Greasy Fork fetches it verbatim |
| Filename | must end `.user.js` — a plain `.js` is rejected as "not a user script" |

**`@version` is the release trigger.** Sync pulls, but a re-upload that does not increment is
ignored — the same rule as a local re-install.

**Point `sync_identifier` at a raw *branch* URL, never a commit.** Greasy Fork's own wording for
a commit-pinned source: it "will never get updated". A branch URL is what makes the sync a sync.

**One webhook secret per user**, not per script — it authenticates you, and every synced script
of yours rides the same one. Treat it as a credential: never in a file, never in a commit,
never echoed.

Without a webhook, Greasy Fork polls roughly every **12 hours**, and **three consecutive
failures park the script for a month**. So a sync that quietly stopped is not always visible as
an error — a script that has not moved in weeks is the symptom.

### The leniency trap — bump `@version` in the same commit, always

The webhook path saves **leniently**: it auto-confirms **every** warning, *including "version
not incremented"* [F-GF-WEBHOOK-LENIENT]. A push that changes code without bumping `@version` is
therefore **accepted** — no error, no rejected upload — and **silently never reaches installed
users**, because the manager has nothing new to update to.

This is the one failure in the publishing path that reports success on both ends. The habit
that defeats it is mechanical: the `@version` bump and the code change are **one commit**.

### Wiring the webhook — read the repo's CI first

Source of every claim below: Greasy Fork's `app/controllers/concerns/webhooks.rb`, `lib/github.rb`
and `lib/gitlab.rb` (read 2026-10-21), plus live deliveries.

1. **Read the repository's own workflows before choosing a sync branch.** A repo can already
   publish through a **gated branch**: CI fast-forwards something like `published` to `main`
   only when lint is green, and the sync URL is supposed to point there. Pointing it at `main`
   instead puts every red push live (happened 2026-10-21; fixed the same day). If no gate
   exists, propose one. Do not use releases: the release handler re-syncs **every** script
   whose sync URL points at the repo, so each unchanged script gets a duplicate history entry.
2. **Set each script's sync URL, and its additional-info sync URL** (`listings/<f>.md` or
   wherever the listing copy lives), on `/scripts/<id>/admin`. Matching is **exact**: a pushed
   file reaches a listing only if one of its raw-URL forms equals that `sync_identifier`
   (GitLab: `…/-/raw/<branch>/<path>`). A hook with no matching URL answers 200 with
   `"No scripts found"` — silent.
   **Check:** `/users/webhook-info` lists every script under "already syncing" with the URL you meant.
3. **Generate the secret on `/users/webhook-info`, only if none exists.** Regenerating breaks
   every hook that uses the old one. The payload URL is on `api.<host>`
   (`https://api.greasyfork.org/en/users/<id>-<slug>/webhook`; Sleazy Fork: `api.sleazyfork.org`).
4. **Create the forge hook.** GitHub: `application/json`, *push* only (any other event gets 406),
   HMAC in `X-Hub-Signature`. GitLab: secret token in `X-Gitlab-Token`, *push events*, and a
   branch filter set to the sync branch.
5. **Prove it**, knowing what each test can actually show:

   | Test | Proves |
   |---|---|
   | GitHub `ping` → 200 *"Webhook successfully configured."* | the secret. A wrong secret gets 403 before the event type is even read |
   | GitHub "test push" (`POST …/hooks/<id>/tests`) | **auth only**: it carries no commits, so it always answers *"No commits found in this push."* [F-GF-GH-TESTPUSH-EMPTY] |
   | GitLab "test push" | the **whole chain**: it replays a real push, so matched scripts come back in `updated_scripts` |
   | First real version bump | the GitHub leg end to end. A script's sync type flips from *Automatic* to *Webhook* only on its first matched delivery |

**Moving the secret without it entering the transcript.** The value sits in a textarea on the
fork's page and has to reach a form on the forge's page. **Never use the clipboard.** A
clipboard-plaintext guard refuses `pbpaste` into anything but a digest. A browser `writeText`
also lands in a clipboard manager's history, and clearing the pasteboard does not clear that
history. What works: inject two buttons into the fork tab. Click the first with a real devtools
click, so `window.open` is a trusted gesture and opens the forge's hook page. Install a
`message` listener there that checks `ev.origin`, fills the form and submits it. Then click the
second button, which `postMessage`s the secret to the opened window. Tool output only ever shows
the hook id. If you snapshot the fork page, save it to a file and grep it: the snapshot contains
the textarea.

**New files never trigger it.** Both push handlers read only each commit's *modified* list,
never *added* [F-GF-WEBHOOK-MODIFIED-ONLY]. A script's first publish stays manual: import it,
then set its sync URLs.

**GitLab specifics.** A CI job that pushes the sync branch with `$CI_REPOSITORY_URL` needs the
project setting `ci_push_repository_for_job_token_allowed=true` (read it back after the `PUT`).
On gitlab.com Free there are no project access tokens. So there is no bot either, and a
GitHub-style auto-merge bot cannot be ported. `only_allow_merge_if_pipeline_succeeds` is the
native substitute.

## The shelf check

Before authoring anything, both hosts answer "has someone already solved this for this domain"
with one no-auth fetch:

```
https://greasyfork.org/en/scripts/by-site/<domain>
https://sleazyfork.org/en/scripts/by-site/<domain>
```

- Use the **bare** domain — `civitai.com`, not `www.civitai.com`.
- **Check Sleazy Fork too** for an adult-adjacent site. The two run **one codebase** and one
  rule set, but a given site's scripts land on **only one** of them, so a Greasy-Fork-only check
  can read as "nothing exists" when a script does.
- A hit is **evidence, not a dependency**: you still cannot `@require` it, and it is the
  script's **measured selectors and its condition** that are worth having — vendor those with
  attribution, or re-derive them.
- This is also the **no-reposts** rule's practical face: an equivalent script already listed is
  a reason to install it, not to ship a rival.

## Before the first upload

- [ ] Search the by-site index for the domain (§ The shelf check). If an equivalent script exists,
      **install it instead of shipping a rival** — that is both the reuse principle and the
      no-reposts rule.
- [ ] Run the lint clean.
- [ ] Check the listing name does not collide.
- [ ] Decide adult-content marking honestly.
- [ ] Confirm `@description` matches what the script actually does — that is a rule, not a nicety.
