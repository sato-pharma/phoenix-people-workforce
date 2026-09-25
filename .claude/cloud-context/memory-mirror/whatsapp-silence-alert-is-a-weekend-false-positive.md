---
name: whatsapp-silence-alert-is-a-weekend-false-positive
description: "SETTLED 2026-08-23: nothing is broken. The ADVERTISED number is the HR handset 01159888247, which is NOT on the Cloud API - applicants CVs sit on that phone and reach the ATS only when a human forwards a batch to +20 10 98500699. Last batch 2026-08-18, so no CVs = nobody forwarded. The Meta app IS Live (owner confirmed); my Development-mode call was WRONG."
metadata: 
  node_type: memory
  type: project
  originSessionId: f09c1e06-e648-4e1e-bdec-d7aa871f0d10
  modified: 2026-08-23T10:25:40.499Z
---

Investigated 2026-07-31 (Fri, Cairo weekend day 1). The recurring "silent" alert is **not** a Meta outage. Do NOT re-subscribe the webhook on this signal — the premise is refuted by direct Graph API evidence.

**Verified intact on Meta's side (2026-07-31):**
- App subscription (`GET /{app-id}/subscriptions` with app token `{app_id}|{app_secret}`): `object: whatsapp_business_account`, `callback_url: https://phoenix-hr.satopharma.com/api/webhooks/whatsapp`, **`active: true`**, `messages` field subscribed (v25.0). Meta's auto-disable sets `active: false` — it is true, so the subscription never lapsed.
- Phone node `1319071451278873`: `status: CONNECTED`, `account_mode: LIVE`, `platform_type: CLOUD_API`, `webhook_configuration.application` = the same callback URL. No per-number override re-routing messages.
- Token: valid, non-expiring `SYSTEM_USER` token, scopes `whatsapp_business_management` + `whatsapp_business_messaging`.
- Meta's last 17 deliveries (2026-07-29) all returned **200** — no failure streak that could trip auto-disable.

**Root cause of the alert = threshold artifact.** `evaluateWhatsAppIntakeHealth` in `src/lib/recruitment/inbound/whatsapp-health.ts` flags `silent` when >24h since the last inbound *intake event* AND `isCairoBusinessHours(now)` (10:00–20:00). That gate covers business **hours** but not business **days** — and Egypt's weekend is **Friday–Saturday**. So any Thursday-evening-to-Sunday quiet period guarantees ~60 error logs per weekend day (6/hour × 10 hours), each one also firing the GCP "Phoenix HR production ERROR log alert". Confirmed exactly: 60 entries on Thu 07-30 and 60 on Fri 07-31, all inside 10:00–19:5x Cairo, silent outside it.

**Decisive corroboration — both channels went quiet together.** `ats_cv_intake_events` shows zero events for BOTH whatsapp and email on 07-30 and 07-31 (prior 4 days: 2-11/day each). Email is an IMAP poller with no dependency on Meta whatsoever. A live call to `GET /api/cron/recruitment-email-intake` returned `messagesSeen: 0` on both INBOX and Bulk with no error — IMAP connects fine and genuinely finds nothing. Two independent transports at zero in the same window = no inbound volume, not a Meta subscription problem. Both crons green (email-intake 288×200 in 2d; inbound-intake 719×200 in 1d) and `ats_inbound_intake_queue` is 100% `done` — nothing stuck or dead-lettered.

**Why: 24h is too tight for this channel.** It does ~1-4 CVs/day, so a single quiet working day trips it. Last real CV: Wed 2026-07-29 09:36 Cairo.

**APPLIED 2026-07-31 (owner-approved): `RECRUITMENT_WHATSAPP_SILENCE_ALERT_HOURS=96`** on the `phoenix-hr` Cloud Run service (europe-west3), set with `gcloud run services update --update-env-vars`. Landed in two steps — 72 first (revision `phoenix-hr-00260-czr`), then 96 when the arithmetic showed 72 still fires Saturday (revision **`phoenix-hr-00261-7kn`**, the live one). Both kept the same image `sha-99312c14`, took 100% traffic, env count 52→53, all conditions Ready; smoke each time: `/api/healthz` 200, `/login` 200, `/api/notifications/daily` 401, `/api/webhooks/whatsapp` 403. Survives future deploys — `deploy-cloud-run.yml` uses `--update-env-vars` (additive), which never clears unrelated vars. Note gcloud's generated revision names (`00260`/`00261`) have LOWER numbers than the workflow's (`00732`); different counters, not a rollback.

**Why 96 and not 72 (the arithmetic that matters):** last inbound 2026-07-29 06:36Z. At Sat 08-01 10:04 Cairo — the first cron tick inside the business-hours gate — it is already **72.5h**, so 72 would have re-fired Saturday morning. 96 covers the whole Fri+Sat weekend (82.4h at Sat 20:00) and next fires **Sun 08-02 10:04 Cairo at 96.5h** if no CV has arrived by then — i.e. it now alerts on the first working day, which is the right semantic. Any pure threshold only buys quiet days; it cannot tell "weekend" from "dead".

**Weekday gate MERGED 2026-07-31 19:28 UTC — [PR #1513](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1513), squash commit `7292c388` on `origin/main`.** All CI green (lint, typecheck, validate, sast-scan, secret-scan, Seer Code Review; full-e2e skipped by condition) and `check:harden` green locally (exit 0, 483 test files + full production build). Worktree `_wt-whatsapp-weekday-gate` and both local/remote branches CLEANED UP (remote was auto-deleted by GitHub on merge); 14 worktrees remain. Reaches production at the next 2-hourly scheduled deploy window — deploys are SCHEDULED, not on push ([[prod-deploy-scheduled-not-on-push]]). Added `isCairoBusinessDay(now)` + `isSilenceAlertWindow(now) = businessDay && businessHours` to `whatsapp-health.ts`, and switched both `isNumberSilent` and `evaluateWhatsAppIntakeHealth` to the combined window.

**Key reuse decision:** the Fri/Sat rule is NOT re-encoded — `isCairoBusinessDay` delegates to `isFieldWorkforceWeeklyOff({ dateIso: cairoDateKey(now) })` from `src/lib/field-workforce-compliance/weekend-policy.ts` (a pure, zero-import leaf module; with no job title it means Friday AND Saturday off). That is the codebase's single definition of the company weekend and the sibling attendance check `attendance/ingestion-health.ts` already routes to it via `isAttendanceScheduledWorkingDay`. Holiday-awareness was deliberately NOT added: it would force the pure sync evaluator to become async + hit the DB every 10 min, and the 96h threshold already absorbs holidays.

**The gate controls WHEN we alert, not how the gap is measured** — hours still accumulate across the weekend, so a webhook that genuinely dies Thursday night is reported Sunday morning rather than forgotten. Tests assert exactly that (weekend → ok, same gap Sunday → silent), plus a Cairo-vs-UTC boundary case (2026-07-30T21:30Z is Thursday in UTC but Friday in Cairo → weekend). Fail-open by design: if `cairoDateKey` ever returned a non-ISO string the weekend helpers return false and the alert still fires.

**✅ CLOSED 2026-07-31 19:44 UTC by a live end-to-end test.** Owner sent a real CV to +20 10 98500699; the whole chain worked: Meta POSTed the webhook at 19:44:42Z (HTTP 200) → queue row `bd43454c` enqueued 22:44:43 Cairo → worker claimed and finished it on attempt 1 at 22:46:19 (~96s door-to-door) → candidate `a7f755fe` created → `lastInboundAt` reset to 19:46:07Z and health went to `status: ok, 0h`. **This definitively proves the WABA subscription and Meta delivery were never broken** — the previously-unverifiable `subscribed_apps` hypothesis is now dead, no dashboard access needed. Also re-confirmed bulk-import mode: sender was 201159888247 (Omar's forwarding handset, in `RECRUITMENT_WHATSAPP_IMPORT_SENDERS`) but the candidate was correctly built from the CV's own identity + the CV's own phone, not the forwarder's.

**⚠️ Separate finding from that test — extraction is captured but NOT applied to candidate columns.** AI extraction (gpt-5.4, position_key `medical_rep`) returned all 12 fields WITH real values including university/faculty/governorate — but the candidate row has those columns NULL; only full_name and phone were written. `applied_fields` is NULL. This is the NORM, not a one-off: **39 of 41 extractions repo-wide have `applied_fields` NULL**, and only 1 of 9 whatsapp candidates has university/governorate populated. So enrichment data sits in `ats_candidate_cv_extractions.extracted_fields` awaiting an apply step rather than landing on the candidate. **ANSWERED (code traced 2026-07-31, all files verified identical to origin/main):** manual BY DESIGN, but with a real reachability gap. `cv-intake-service.ts` applies only the IDENTITY TRIPLE — `candidateIdentityFromCvFields` (cv-extraction.ts:287-296) reads solely `fullName`/`email`/`phone`, and `createCandidate` is passed only `{email, fullName, notes, phone, source}`. Everything else is persisted to `extracted_fields` as a PROPOSAL. `applied_fields` is written only by `recordAppliedExtractionFields`, whose single caller is `PATCH /api/recruitment/candidates/[id]` when the body carries `extractionId` — i.e. only when a human saves a reviewed form. The migration comment says the same thing outright. **The gap:** the review UI exists on only two MANUAL paths — `bulk-cv-extraction-panel.tsx` (create-from-CV bulk upload) and `startRetryExtraction` in `recruitment-workspace.tsx` (a per-candidate "re-run extraction" button). Nothing surfaces "this auto-intake candidate has N unreviewed AI fields", so for WhatsApp/email arrivals the proposal is invisible, and the only way to reach it re-runs the AI — a SECOND paid call to regenerate fields already sitting in the DB. That matches the numbers exactly (39/41 unapplied; the 2 applied are the manual path). File storage on that test: `ats_files` row created with `drive_file_id` set but `external_url` NULL.

**Method notes for re-running this diagnosis:**
- WhatsApp secrets are **Secret Manager refs, not inline env**. `gcloud run services describe ... --format json` returns empty `.value`; fetch with `gcloud secrets versions access latest --secret=WHATSAPP_ACCESS_TOKEN --project phoenix-workforce-498619` (same for `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `CRON_SECRET`). Only `WHATSAPP_PHONE_NUMBER_ID` (1319071451278873) and `RECRUITMENT_WHATSAPP_IMPORT_SENDERS` are inline.
- Calling `GET /api/cron/recruitment-email-intake` with `Authorization: Bearer $CRON_SECRET` returns the **live** WhatsApp health object plus email mailbox summaries in one shot — fastest single check.
- `gcloud logging read` filters need `AND` between terms and the `:` substring operator works only inside a properly quoted filter; from the PowerShell tool escape inner quotes as `\"`.
- The WABA-level check `GET /{waba-id}/subscribed_apps` could NOT be run: the token lacks `business_management` and the WABA id is not resolvable from any edge this token can see (`me/assigned_whatsapp_business_accounts` is empty; business `2447906605705551` = "Phoenix HR Workforce" rejects the WABA edges). That is the one hypothesis only the owner's Meta dashboard can close. `subscriptions_sample` is unavailable for this app (OAuthException 2500).

Related: [[whatsapp-cv-intake-silent-since-2026-07-25]], [[whatsapp-intake-observability-and-second-number]], [[notification-confidence-gate-and-paused-crons]].

---

## 2026-08-23 — it fired AGAIN at 96h, and this time the alarm itself was fixed

The owner said "fix the whatsapp intake". Re-ran the whole diagnosis against live Meta + prod DB:
**still a false positive, every layer healthy.** Number `CONNECTED`, token valid non-expiring
SYSTEM_USER, app subscription `active: true` with `messages`, `callback_url` AND the per-number
`webhook_configuration.application` both = the production webhook URL, our endpoint returns **403**
to a bad verify token and **401** to an unsigned POST (so route + verify token + app secret are all
live), `ats_inbound_intake_queue` = 626 rows **all `done`**, nothing dead-lettered.

**Why 96h was still wrong — the number that settles it.** Gap census over the channel's whole
history: the normal inbound gap has reached **333.3 hours** (08-01 00:20 → 08-14 21:40, ended by a
bulk import, nothing wrong). So the alert fired for ~10 CONSECUTIVE DAYS in early August, pushing
Telegram daily, and was firing again on 08-23 at 109h. **An alert that is on during normal operation
cannot signal an outage** — the real 2026-07-26 block would have been invisible inside that noise.
No pure threshold fixes this; the 07-31 note already suspected as much ("any pure threshold only
buys quiet days; it cannot tell weekend from dead") — 333h proves it.

**Second, worse half: bulk imports MASK the detector.** `lastInboundWhatsAppAt()` takes the newest
event of ANY kind, and **371 of 390** WhatsApp intake events are bulk forward-imports, not
applicants. A bulk forward therefore RESETS the silence clock. Organic CVs were **zero from 07-31 to
08-17** — a genuine three-week applicant drought — and the alarm never mentioned it, because HR
forwards on 08-14/15/16 kept the clock fresh. It is quiet about what matters and loud about what
does not. (08-18's 346 events were one paced import, ~10 per 2 min from 20:50 to 22:04 — NOT a busy
day. Always split `raw_metadata->>'bulkImport'` before reading WhatsApp volume as demand.)

**FIXED in [PR #2327](https://github.com/Gawish-1997/phoenix-people-workforce/pull/2327), squash
`c741b23b`, merged 2026-08-23 13:24 Cairo.** Silence stays, still logged as a WARNING, and **stops
paging**. What pages is now the new deterministic status **`webhook_misrouted`**, checked every
10-min tick with credentials the app already holds:
- `GET /{app-id}/subscriptions` — the `whatsapp_business_account` entry must be `active`, include
  the **`messages`** field, and its `callback_url` must equal the production webhook URL.
- `GET /{phone-number-id}?fields=webhook_configuration` — **a per-number override BEATS the
  app-level URL**, so a stale one silently reroutes everything while all else looks correct.

`api_unreachable` still outranks it (one incident, one alert). An unanswerable check returns
`ok: null`, **never `false`** — a network blip must not page with a fake misconfiguration. The app
id is read back from `debug_token`, so there is no new env var to drift from the token beside it.
New exports in `whatsapp-health.ts`: `fetchWebhookRouting`, `evaluateWebhookRouting`,
`expectedWebhookUrl`, `normalizeCallbackUrl`. Tests mutation-proven 4/4, live production
subscription pinned as a fixture.

**The WABA wall is unchanged and is now DESIGNED AROUND, not fought.** `me/assigned_whatsapp_business_accounts`
still returns `{"data":[]}` and the token still lacks `business_management`, so
`GET /{waba-id}/subscribed_apps` remains unrunnable (same as 07-31). The app-level subscription +
per-number override checks are the reachable proxies — do not burn another session hunting the WABA id.

**Stale bits in the 07-31 section above:** `RECRUITMENT_WHATSAPP_SILENCE_ALERT_HOURS=96` now lives in
**Railway** production env, not Cloud Run (GCP is dead, [[gcp-is-dead-not-standby]]). It now only
controls when the WARNING appears and pages nobody either way; raising it to ~336 would quiet the log
too, but that is a prod env change + redeploy and was NOT done.

**Open, and NOT an engineering question:** organic WhatsApp CVs ran 2–5/day to 07-29 then ~0. Whether
the number is still being advertised to applicants is the real question behind "no CVs arriving".

Related: [[a-cron-that-fails-nightly-can-do-so-forever-unwatched]], [[never-silent-drop-count-and-flag-instead]].

---

## 2026-08-23 (later) — SETTLED: nothing is broken. The advertised number is not the API number.

The owner answered the closing question with **"yes it's advertised, no cvs coming"**, refuting the
"quiet channel" verdict above — then, on being asked directly, confirmed **the number on the job ads
is the HR handset `01159888247`**, and that **the Meta app IS in Live mode**.

**So the chain has a HUMAN STEP in the middle, and the human stopped.** `01159888247` is a normal
WhatsApp Business app phone, NOT on the Cloud API ([[whatsapp-intake-observability-and-second-number]],
owner's 2026-07-27 "keep forwarding" decision after coexistence proved unavailable in the dashboard).
Applicants message it, their CVs sit on that handset, and they reach the ATS **only when a person
forwards a batch** to the Cloud API number `+20 10 98500699`. Last batch: **2026-08-18**. "No CVs
coming" = nobody has forwarded for five days. No Meta fault, no code fault.

**🔴 I GOT THIS WRONG FIRST — the wrong answer is recorded here deliberately.** From the sender
census I concluded the Meta app was still in **Development mode** (the unfinished item in
[[whatsapp-cv-intake-silent-since-2026-07-25]]) because `GET /1725159208692148/roles` returns exactly
**2 users, both `administrators`** (one confirmed Omar Gawish via `me` -> `122097391851413723`) and
exactly **2 numbers still deliver**. That correlation is a **coincidence** — those two people are
simply the two who do the forwarding, and they are also the two entries in
`RECRUITMENT_WHATSAPP_IMPORT_SENDERS`. **A 2-for-2 match on n=2 is not evidence.** Ask which number
is advertised BEFORE theorising about Meta.

**The census that is still valuable and true** (`ats_inbound_intake_queue`, 382 whatsapp rows, all
`source = whatsapp_webhook`): exactly **9 numbers have EVER delivered**. Omar Anwar `201280955558`
(342 msgs, to 2026-08-18), Omar Gawish `201159888247` (31, to 2026-08-18), and **7 outside numbers
totalling 9 messages, all inside 2026-07-27 -> 07-29 and never since.** Omar Anwar's batch carries
per-CV captions ("sheraton resisdent") — a human uploading a collected pile, not applicants writing
in. `RECRUITMENT_WHATSAPP_IMPORT_SENDERS` is NOT a delivery filter: the route uses
`isWhatsAppImportSender` only for source-context attribution, never to gate the enqueue (verified in
`app/api/webhooks/whatsapp/route.ts`).

**The discriminator that proved applicants exist.** Email is an independent transport into the same
ATS: last 10 days **163 events from 149 DISTINCT senders**, newest candidate 2026-08-20 11:56 Cairo,
mailbox still polling 2026-08-22 22:36. **Always compare the two channels before calling a drought** —
that single query is what turned "nobody is applying" into "one road is a manual chute".

**Live Meta state 2026-08-23, for reference** (all healthy, all beside the point): app subscription
`active: true` with `messages`; `callback_url` and per-number `webhook_configuration.application`
both correct; phone `CONNECTED`, `account_mode: LIVE`, `platform_type: CLOUD_API`. Also
`messaging_limit_tier: TIER_250`, `is_official_business_account: false`, `quality_rating: UNKNOWN`,
`code_verification_status: EXPIRED`, and app `terms_of_service_url` is the placeholder
`https://www.facebook.com/` while `privacy_policy_url` is real (`app/privacy/page.tsx` exists; there
is **no `/terms` page**). Unreadable with this token, same wall as 07-31: business verification and
`GET /{waba-id}/subscribed_apps` (`business_management` missing,
`me/assigned_whatsapp_business_accounts` returns `[]`, business `2447906605705551` 403s).

**The real defect is that this is unmonitorable as designed.** #2327's `webhook_misrouted` probe
verifies Meta's CONFIG and returns `ok: true` throughout — it cannot see that the channel depends on
a person remembering to forward. Alerting on "no inbound WhatsApp for 96h" is really alerting on
"HR has not done a batch upload this week": a staffing signal dressed as an outage. **Never report
this channel healthy from config alone** — measure distinct OUTSIDE senders and compare with email.

**The durable fix is to remove the human step**, in priority order: (1) re-check whether Meta
**Coexistence** is available now — it was refused in the dashboard on 2026-07-27, ~1 month ago, and
would let `01159888247` stay usable on the handset while feeding the ATS automatically; (2) failing
that, advertise `+20 10 98500699` directly (cost: a CLOUD_API number cannot be opened in the
WhatsApp app, so HR loses handset chat); (3) at minimum, alert when no batch has arrived in N days.
