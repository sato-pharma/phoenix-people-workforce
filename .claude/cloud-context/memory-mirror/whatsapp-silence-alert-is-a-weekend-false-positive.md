---
name: whatsapp-silence-alert-is-a-weekend-false-positive
description: "SETTLED: the WhatsApp intake 'silence' alert is NOT an outage. The advertised recruitment number is the HR HANDSET 01159888247, which is NOT on the Cloud API — applicant CVs sit on that phone and reach the ATS only when a HUMAN forwards a batch to +20 10 98500699, so 'no CVs' = nobody forwarded. The Meta app IS Live. The channel is unmonitorable from config alone (every Meta check reads healthy); measure distinct OUTSIDE senders and compare with email before calling a drought, and split bulkImport before reading WhatsApp volume as demand."
metadata: 
  node_type: memory
  type: project
  originSessionId: f09c1e06-e648-4e1e-bdec-d7aa871f0d10
  modified: 2026-09-26T05:22:36.196Z
---

**SETTLED 2026-08-23 — nothing is broken; do NOT re-investigate this as a Meta or code outage.** The
recurring "WhatsApp intake silent" alert has a HUMAN STEP in the middle that stopped.

**The chain:** the number advertised to applicants is the HR handset **`01159888247`**, a normal WhatsApp
Business app phone that is **NOT on the Cloud API**. Applicants message it, their CVs sit on that handset, and
they reach the ATS **only when a person forwards a batch** to the Cloud API number **`+20 10 98500699`**. So
"no CVs coming" means nobody has forwarded — no Meta fault, no code fault. The Meta app IS in Live mode
(owner confirmed). This is the owner's own 2026-07-27 "keep forwarding" arrangement after Coexistence proved
unavailable in the dashboard ([[whatsapp-intake-observability-and-second-number]]).

## Why this channel is unmonitorable as designed

🔴 **Every Meta-config check reads healthy, because the dependency is "a person remembering to forward" —
which config cannot see.** Alerting on "no inbound WhatsApp for N h" is really alerting on "HR hasn't done a
batch upload this week": a staffing signal dressed as an outage. **Never report this channel healthy from
config alone.** The two things that actually tell you what is happening:

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
- **The durable fix removes the human step**, in priority order: (1) re-check Meta **Coexistence** (refused
  2026-07-27, would let the handset feed the ATS automatically); (2) advertise `+20 10 98500699` directly
  (cost: a CLOUD_API number cannot be opened in the WhatsApp app, so HR loses handset chat); (3) at minimum,
  alert when no batch has arrived in N days.
- ⚠️ **Separate finding — CV extraction is captured but NOT applied to candidate columns, BY DESIGN.**
  `cv-intake-service.ts` applies only the identity triple (fullName/email/phone) on auto-intake; every other
  extracted field is persisted to `ats_candidate_cv_extractions.extracted_fields` as a PROPOSAL, and
  `applied_fields` is written only when a human saves a reviewed form (`PATCH /api/recruitment/candidates/[id]`
  with `extractionId`). The reachability gap: nothing surfaces "this auto-intake candidate has N unreviewed AI
  fields", and the only UI route to apply them re-runs the AI — a second paid call to regenerate fields
  already sitting in the DB.
