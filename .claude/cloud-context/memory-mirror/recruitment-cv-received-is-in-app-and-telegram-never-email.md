---
name: recruitment-cv-received-is-in-app-and-telegram-never-email
description: "Owner rule — the recruitment 'new CV received' NOTIFICATION is in-app + Telegram only, never email. NARROWED 2026-08-27: the owner approved a separate 6-hourly CV digest email that bypasses the pipeline."
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-27T00:34:55.261Z
  originSessionId: 37a31ab8-ff78-4313-8b88-d0c427994a7e
---

Owner decision, **2026-08-15**: the "new CV received" notice to Talent Acquisition/Super Admin
(`eventType: "recruitment_inbound_cv"`, fired from `notifyTalentAcquisitionOfInboundCv` in
`src/lib/recruitment/inbound/recruitment-notify.ts`) must never be emailed — in-app + Telegram
(+ push) only now. Shipped in [PR #2155](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2155),
merged and confirmed live on production (`revision 0b3a087d2b524185e6bebd10033e478c67c1d8f7`
on `/api/healthz`) 2026-08-15.

## ⚠️ NARROWED 2026-08-27 — the owner approved a CV digest email. Do NOT undo it.

He was shown this rule verbatim, told that [PR #2438](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2438)
contradicted it, and answered that he wanted it merged anyway. **That is a live owner decision and it
outranks the 2026-08-15 note below.** It merged as `63ff936b` and was serving on production by
03:34 Cairo the same night.

What changed, precisely — the rule below is **narrowed, not repealed**:
- **Still true:** the per-CV *notification* `recruitment.recruitment_inbound_cv` is in-app +
  Telegram + push, never email. `enforceRecruitmentCvEmailBlock` stays. Do not touch it.
- **New exception:** `src/lib/recruitment/inbound/cv-intake-digest-6h.ts` sends a **6-hourly
  summary** email to each manager who had candidates pushed to them, via a direct
  `sendPhoenixEmail` call. It does **not** go through `basePolicyChannels`, so none of the five
  email-block guards see it. That bypass is why it works — it is deliberate, not an oversight.
- Recipients: the manager's `work_email`; CC their own manager (DM and RM yes, **NSM no**);
  `omar.anwar@satopharma.com` always in CC. Idempotency key
  `cv-intake-digest-6h:<hrId>:<windowKey>` — so **never fire it from the laptop**, that burns the
  key for the real run (same trap as [[candidate-push-to-a-hiring-manager-is-never-emailed]]).

**It is LIVE AND SCHEDULED as of 2026-08-27 03:47 Cairo** — cron-job.org job **8334658**: enabled,
`GET`, 300s timeout, `hours=[0,6,12,18] minutes=[47] Africa/Cairo`, first run 06:47 Cairo. Its
`Authorization` header matches the known-good `phoenix-recruitment-email-intake` job byte for byte
(len 71, `Bearer ` prefix), so it authenticates — this is not a half-rotation.

**Beware the ordering trap that caught the session that wrote this.** At 03:33 the same API returned
**zero** jobs for this route, and "the feature is inert, it will never send" was reported to the owner
as fact. By 03:47 the job existed — created by someone else in that 14-minute gap. Registering a job
in `src/lib/cron-control/job-registry.ts` still creates NO schedule (that module is a dashboard over
the DEAD GCP scheduler), so the cron-job.org listing is the only source of truth — **re-read it live
rather than quoting this file.**

## The original rule (still governs the notification path)

**Enforced with the same two-layer pattern as [[early-birds-is-in-app-and-telegram-never-email]]**,
payslips, and marketing-SLA reminders:
- `policy.ts` exact key `"recruitment.recruitment_inbound_cv"` sets the intent:
  `channels: ["in_app", "telegram", "push"]`.
- `src/lib/notifications/recruitment-cv-channel-guard.ts` (`enforceRecruitmentCvEmailBlock`) is the
  hard post-filter, chained last in `basePolicyChannels` in `system.ts`, after
  `enforceAttendanceAlertEmailBlock`. It strips email from the RESOLVED channel list regardless of
  the policy table, an explicit call-site `channels`, or the Telegram-failure fallback
  (`triggerTelegramRetryExhaustionFallback`) that re-enters with `["email","in_app","push"]` —
  which matters here specifically because Telegram failing is the expected case while a reviewer
  hasn't linked Telegram yet.
- Keyed on **module `recruitment` + eventType `recruitment_inbound_cv`** only (not the whole
  module) — every other recruitment notification (offers, interviews, the WhatsApp-intake-down /
  dead-letter / spike alerts, which were already Telegram-only) is untouched.
- Regression test: `tests/recruitment-cv-no-email.test.ts`, registered in `tests/run-tests.ts`.

**Why:** owner request to stop CV-intake emails, keep only Telegram + in-app.

**How to apply:** don't "fix" this back by re-adding email to the `recruitment.recruitment_inbound_cv`
policy row or by loosening/removing `recruitment-cv-channel-guard.ts` — that guard existing at all is
the point, exactly as with the other four email-block guards in this file's sibling entries. If a
future recruitment event type genuinely needs email, give it its own policy key rather than widening
this guard's match. **And do not delete the 6-hourly digest on the strength of the guard** — the
owner overrode that himself on 2026-08-27. See also [[never-fire-bulk-emails-ever]], whose "ever" now
has this one owner-granted exception.
