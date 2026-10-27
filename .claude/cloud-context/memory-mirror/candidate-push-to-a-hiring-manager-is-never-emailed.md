---
name: candidate-push-to-a-hiring-manager-is-never-emailed
description: "OWNER RULE 2026-08-24 — sending a candidate to a hiring manager is in-app + push ONLY, never email; the Send button emailed unconditionally until PR #2372 added the sixth channel guard"
metadata:
  node_type: memory
  type: project
  originSessionId: d4e5345d-3a7a-4195-9b35-7fdcfc2b6de7
---

**OWNER RULE, stated 2026-08-24: a candidate pushed to a hiring manager reaches them IN-APP, by
TELEGRAM and by PUSH. Never email.** Do not "fix" this back, and do not restore email to `candidate_assigned` on the
grounds that a manager might miss the alert.

He said it while a 14-person shortlist for the vacant **Upper Egypt 2 anti-infective district
manager** seat was ready to go to that line's NSM. Asked *who* should receive it, he answered
**"no dont send emails"** — a rejection of the mechanism, not of the recipient.

**Why nothing could honour it before #2372.** `pushCandidatesToManager` passed
`channels: ["in_app", "email", "push"]` at the call site, and `resolveBasePolicyChannels` returns an
explicit call-site list **verbatim** (`if (input.channels?.length) return dedupeChannels(input.channels)`).
So the Send button emailed **unconditionally** — no policy row, admin setting or per-send option was
ever consulted. The five existing email blocks each key on their own event and none covered this one.

**How to apply:**
- The rule is enforced in **three** layers, and the third is the one that actually holds: both call
  sites in `hiring-manager-notify.ts` pass `["in_app","push"]`; a `recruitment.candidate_assigned`
  policy row states the intent; and `enforceCandidateAssignedEmailBlock` strips email from the
  **resolved** list. Only the guard survives the **Telegram-failure fallback**, which re-enters the
  pipeline with `["email","in_app","push"]` whatever the original send asked for.
- **`recruitment.*` still carries email**, so `candidate_assigned` needed its OWN policy row —
  falling through would have emailed the exact notice the rule forbids. Same trap the daily CV
  digest hit. See [[recruitment-cv-received-is-in-app-and-telegram-never-email]].
- Keyed on module + the single `candidate_assigned` event type, which **both** call sites write (the
  direct push and the requisition-level assignment). Offers, interviews and the rest of
  `recruitment.*` keep their email.
- **Telegram WAS added, same night, on his follow-up "add telegram too"** (#2373, merge `6b9468ba`).
  Live channels are now **in-app + Telegram + push**. The guard needed no edit at all: it strips
  email *and only email*, so it is a block on one channel, not an allow-list of the others — never
  rewrite it into a whitelist, that would silently drop Telegram and still look correct.
- **Telegram delivers NOTHING to almost everyone today.** `telegram_connections` on production,
  read 2026-08-24: only **2** rows are `status = 'connected'` with a chat id — 8 are `pending`, 1
  `failed`. **Magdy is `pending`, never linked.** The deliverable status is the literal
  **`connected`**; there is no `linked` value, so a query using one silently returns 0 for everybody.
  Linking is per-person and cannot be done for them: portal **Profile** page → Connect Telegram.
- An unlinked Telegram is the EXPECTED case, and its failure fallback re-enters the pipeline asking
  for `["email","in_app","push"]` — the email guard is what stops that becoming an email. The two
  changes cover each other.
- The module's Telegram governance must stay `enabled: true, genericOnly: false` for `recruitment`.
  `genericOnly` would collapse the message to "you have a notification" and delete the only thing it
  carries, the candidates' names. Note the sibling **`offers` module is deliberately DISABLED** for
  Telegram because candidate data is sensitive — recruitment being enabled is a real prior decision,
  and this alert does name candidates to a third party.

**NEVER fire this send from the laptop.** `.env.local` points at production but has no
`EMAIL_NOTIFICATIONS_ENABLED`, and worse, `eventKeyFor` in `system.ts` derives the idempotency key
from a **sha256 of `{actionUrl, eventType, module, recipientHrId, recipientUserId, title}` — no
timestamp, no candidate list**. The multi-send title is `"N new candidates to review"`, so a local
run **permanently burns** the key for that exact (manager, count) pair and the real send from
production is then skipped forever. See [[local-run-against-prod-db-silently-skips-every-email]].

The hiring manager for that seat is **Magdy El Senosey** (`AI-0008`, National Sales Manager,
anti-infective) — `SEAT-AIF-DM-UE-2` reports directly to `SEAT-AIF-NSM`. **The CEO is not in the
dropdown at all**: `listHiringManagerOptions` matches job titles containing manager/director/head/
chief, and Dr Anwar's title is `Ceo`.

## Narrowed 2026-08-27 — a 6-hourly SUMMARY may now be emailed

Owner approved [PR #2438](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2438) after
being shown this rule. The **per-push** notification is still never emailed; what is new is a
**batched 6-hour digest** ("you received N CVs") from
`src/lib/recruitment/inbound/cv-intake-digest-6h.ts`, which calls `sendPhoenixEmail` directly and so
never meets the guards. It carries its own idempotency key
`cv-intake-digest-6h:<hrId>:<windowKey>`, so the "never fire from the laptop" warning above applies
to it with full force. Live on cron-job.org job **8334658** since 2026-08-27, every 6h at :47 Cairo.
Full detail: [[recruitment-cv-received-is-in-app-and-telegram-never-email]].
