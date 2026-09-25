---
name: facebook-group-posting-cannot-be-automated-ever
description: "Facebook group auto-posting is IMPOSSIBLE, not hard — Meta deleted the Groups API 2026-04-22 and personal accounts have had no publishing API since 2018; the owner has asked for it twice"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0a4225a0-74c2-4b20-accd-501f8fcdc660
  modified: 2026-08-24T21:10:01.935Z
---

**The owner has asked for this twice (2026-08-24), the second time after being told no.** He wants
Phoenix linked to a Facebook account — specifically a "Satopharma HR" persona account — handed a
list of group links, and posting vacancies into them automatically. It cannot be built. Say so
plainly and build the tracked-link half instead; do not quietly attempt a browser-automation
workaround.

**The three facts, verified by web search 2026-08-24:**

1. **Groups API: deleted, not restricted.** Deprecated with Graph API v19 (Jan 2024), **removed from
   every version on 2026-04-22**, `publish_to_groups` and `groups_access_member_info` gone with it.
   Buffer, Hootsuite, Zoho and Sprinklr all lost group posting the same day. Meta's stated reason
   was spam. There is no app review that unlocks it.
2. **Personal accounts have no publishing API at all** — `publish_actions` was removed in 2018. So
   "log the HR account in and let it post" has no official path even to its own timeline.
3. **Facebook Jobs does not exist in Egypt.** Shut down outside US/Canada Feb 2022, everywhere Feb
   2023, revived Oct 2025 as a **US-only** Marketplace tab for entry-level/trade work. An Egyptian
   vacancy on Facebook is an ordinary post, nothing more.

**What IS automatable:** posting to a **Page** you administer, via `POST /{page-id}/feed` with
`pages_manage_posts` + `pages_read_engagement` + `pages_show_list`. He explicitly does **not** want
this — he wants the persona account posting into groups.

**Why not to build the browser-automation workaround.** It is the only mechanism that would work,
and it is what Facebook's spam detection is built to catch — one account posting the same ad into
twenty groups is the textbook signature. Two specific costs here: a role/persona account
("Satopharma HR") already violates the real-name rule, and **that account plausibly admins the Meta
app carrying the WhatsApp integration** — see [[whatsapp-coexistence-verified-state-2026-08-24]]. A
restriction would take WhatsApp intake down with it.

**What was built instead — PR #2400, `codex/recruitment-job-post-channels`.** Automate both sides of
the human paste, and close the attribution gap that actually costs money: measured 2026-08-24, all
**426 candidates** carried `source` = `whatsapp` (219) / `email` (207) and nothing finer, so nobody
could say which of twenty groups was worth posting in.

- `ats_job_post_channels` — one row per group, each with a short `PX-` code.
- The composer writes the advert once and appends **that group's own apply link** (`wa.me`
  pre-filled or `mailto`); one click copies and opens the group.
- The applicant sends the pre-filled message, so the code arrives in their own first words — which
  `coverMessage` already carries on both channels, so neither intake path changed.
- Intake stamps `ats_cv_intake_events.source_channel_code`; the panel reports distinct candidates
  per group.

**Why the `PX-` prefix matters:** the extractor runs over free text an applicant typed. An
over-long token is rejected outright rather than truncated to a real code — a wrong attribution is
worse than none, because it is the number used to decide which groups to drop.

**OWNER STANDING RULE, 2026-08-25: "never post anything until i tell u."** Said unprompted the
night the 43-channel directory landed. Read it at its widest — no advert, no message, no outward
publication to ANY of the 43 channels or anywhere else, on any platform, until he says so for that
specific post. It is not satisfied by "the code cannot post anyway"; it also forbids a session
doing it by hand through a browser, a connector, or a pasted message.

He was told, and it is true, that nothing has posted and no publish path exists: the only "publish"
string in the outreach module is a comment; `copyForChannel` only calls `navigator.clipboard.writeText`
plus `window.open`; and the module's single `fetch` targets the app's own API. Verified 2026-08-25.
Do not re-litigate that — just do not post.
