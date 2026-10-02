---
name: whatsapp-silence-alert-is-a-weekend-false-positive
description: "The WhatsApp intake 'silence' alert is a weekday-gated WARNING, not proof of an outage. Today the advertised apply number on PRODUCTION is the automated 010 line (01098500699, since 2026-08-28) and the HR handset 01159888247 is on the Cloud API by Coexistence (since 2026-09-11), so CVs to either arrive automatically — silence is no longer 'nobody forwarded' and may be a real intake fault. Config checks can read healthy regardless: compare with email and split bulkImport before calling a drought."
metadata: 
  node_type: memory
  type: project
  originSessionId: f09c1e06-e648-4e1e-bdec-d7aa871f0d10
  modified: 2026-10-02T16:40:10.457Z
---

**Current state — the human step is gone** ([[whatsapp-coexistence-verified-state-2026-08-24]]):

- **`RECRUITMENT_APPLY_WHATSAPP_NUMBER` is `01098500699` — the automated 010 Cloud API line — on
  PRODUCTION since 2026-08-28** (owner: *"automate everything"*); every new advert and `PX-` apply link
  carries `https://wa.me/201098500699`. Adverts already pasted with 011 still work. Staging is
  deliberately still `01159888247`.
- **Coexistence is LIVE since 2026-09-11 ~02:16 Cairo:** the handset **`+20 11 59888247`** reads
  `Connected` on the Cloud API (`phone_number_id 477586495433549`) AND still runs WhatsApp Business on the
  phone, so CVs sent to it flow into intake automatically. `WHATSAPP_PHONE_NUMBER_IDS` carries both line
  ids, so the silence monitor watches both.
- So **"no CVs" no longer means "nobody forwarded"** — with both lines automatic, a silent channel may be a
  real intake fault and has to be diagnosed. One phone-side cause to rule out first: the handset's
  connection drops if the WhatsApp Business app is not opened at least once every 14 days (or if someone
  taps the *Connected platform* card), and neither recovers without re-running onboarding.
**Superseded 2026-10-02:** previously "the advertised number is the HR handset, NOT on the Cloud API; CVs reach the ATS only when a human forwards a batch, so 'no CVs' = nobody forwarded" — the 2026-08-28 advertised-number switch and 2026-09-11 Coexistence (`whatsapp-coexistence-verified-state-2026-08-24`).

**What was SETTLED on 2026-08-23 (history):** nothing was broken then — the recurring "WhatsApp intake
silent" alert had a HUMAN STEP in the middle that had stopped.

**The chain as it stood then:** the number advertised to applicants was the HR handset **`01159888247`**, a
normal WhatsApp Business app phone that was **NOT on the Cloud API**. Applicants messaged it, their CVs sat on
that handset, and they reached the ATS **only when a person forwarded a batch** to the Cloud API number
**`+20 10 98500699`** — still the sanctioned route for an old CV sitting in the handset's chats. The Meta app IS
in Live mode (owner confirmed). That was the owner's own 2026-07-27 "keep forwarding" arrangement after
Coexistence proved unavailable in the dashboard ([[whatsapp-intake-observability-and-second-number]]).

## Why this channel cannot be judged from config alone

🔴 **Every Meta-config check could read healthy while no CV arrived** — in 2026-08 because the dependency
was "a person remembering to forward", which config cannot see; alerting on "no inbound WhatsApp for N h"
was then really alerting on "HR hasn't done a batch upload this week". **Never report this channel healthy
from config alone.** The two things that actually tell you what is happening:

- 🔴 **Compare it with EMAIL, an independent transport into the same ATS, before calling a drought.** That
  single comparison is what turned "nobody is applying" into "one road is a manual chute" — email was still
  receiving CVs from many distinct senders while WhatsApp organic volume was zero.
- 🔴 **Split `raw_metadata->>'bulkImport'` before reading WhatsApp volume as demand.** ~95% of WhatsApp intake
  events are bulk forward-imports, not applicants, and `lastInboundWhatsAppAt()` takes the newest event of
  ANY kind — so **a bulk forward RESETS the silence clock and masks a genuine applicant drought**. (A real
  three-week drought went unmentioned because HR forwards kept the clock fresh.) `RECRUITMENT_WHATSAPP_IMPORT_SENDERS`
  is NOT a delivery filter — the webhook route uses `isWhatsAppImportSender` only for source attribution,
  never to gate the enqueue.

## The threshold history — why no pure threshold works

The alert began as a business-HOURS gate that ignored business DAYS: Egypt's weekend is **Friday–Saturday**,
so any weekend fired dozens of error logs. Raising `RECRUITMENT_WHATSAPP_SILENCE_ALERT_HOURS` (72→96, now on
**Railway** env — GCP is dead, [[gcp-is-dead-not-standby]] — and it now only controls when the WARNING
appears and pages nobody) only bought quiet days. 🔴 **The normal inbound gap has reached 333 hours** (a
legitimate quiet stretch ended by a bulk import), so **an alert that is on during normal operation cannot
signal an outage** — a real block would be invisible inside that noise. A pure threshold cannot tell
"weekend" from "dead" ([[a-cron-that-fails-nightly-can-do-so-forever-unwatched]]).

**What the code does now:** a weekday gate `isSilenceAlertWindow(now) = businessDay && businessHours` in
`whatsapp-health.ts`, where `isCairoBusinessDay` delegates to `isFieldWorkforceWeeklyOff` — the codebase's
single definition of the company weekend, **not re-encoded** (the sibling attendance check routes to the same
leaf module). The gate controls WHEN we alert, not how the gap is measured — hours still accumulate across
the weekend, so a webhook that genuinely dies Thursday night is reported Sunday, not forgotten. Silence now
logs a WARNING and pages nobody; what PAGES is the deterministic status **`webhook_misrouted`**, checked with
credentials the app already holds:

- `GET /{app-id}/subscriptions` — the `whatsapp_business_account` entry must be `active`, include the
  **`messages`** field, and its `callback_url` must equal the production webhook URL.
- `GET /{phone-number-id}?fields=webhook_configuration` — 🔴 **a per-number override BEATS the app-level URL**
  and silently reroutes everything while all else looks correct.

An unanswerable check returns `ok: null`, **never `false`** — a network blip must not page as a fake
misconfiguration; `api_unreachable` outranks it. Holiday-awareness was deliberately NOT added (it would force
the pure sync evaluator to hit the DB every 10 min; the threshold absorbs holidays).

## The WABA wall — design around it, don't fight it

`me/assigned_whatsapp_business_accounts` returns `[]` and the SYSTEM_USER token lacks `business_management`,
so `GET /{waba-id}/subscribed_apps` is unrunnable — the app-level subscription + per-number override checks
are the reachable proxies. **Do not burn a session hunting the WABA id.** WhatsApp secrets are Secret Manager
refs, not inline env; `GET /api/cron/recruitment-email-intake` with the CRON_SECRET bearer returns the live
WhatsApp health object plus email mailbox summaries in one call — the fastest single check.

## Two lessons and one separate finding

- 🔴 **A 2-for-2 correlation on n=2 is not evidence** (recorded deliberately as a wrong answer): "2 admins =
  2 delivering numbers" led to a wrong Development-mode conclusion ([[whatsapp-cv-intake-silent-since-2026-07-25]]);
  those two people are simply the two who forward. **Ask which number is advertised BEFORE theorising about
  Meta.**
- **The durable fix removed the human step — BOTH options are DONE:** (1) Meta **Coexistence** (refused
  2026-07-27) went LIVE 2026-09-11, so the handset feeds the ATS automatically; (2) `+20 10 98500699` has
  been the advertised number on production since 2026-08-28. The fallback (3), "alert when no batch has
  arrived in N days", was framed for the forwarding era. See [[whatsapp-coexistence-verified-state-2026-08-24]].
  **Superseded 2026-10-02:** previously "the durable fix, in priority order: re-check Coexistence; advertise the 010 line; at minimum alert on no batch" as open options — both done (`whatsapp-coexistence-verified-state-2026-08-24`).
- ⚠️ **Separate finding — CV extraction is captured but NOT applied to candidate columns, BY DESIGN.**
  `cv-intake-service.ts` applies only the identity triple (fullName/email/phone) on auto-intake; every other
  extracted field is persisted to `ats_candidate_cv_extractions.extracted_fields` as a PROPOSAL, and
  `applied_fields` is written only when a human saves a reviewed form (`PATCH /api/recruitment/candidates/[id]`
  with `extractionId`). The reachability gap: nothing surfaces "this auto-intake candidate has N unreviewed AI
  fields", and the only UI route to apply them re-runs the AI — a second paid call to regenerate fields
  already sitting in the DB.
