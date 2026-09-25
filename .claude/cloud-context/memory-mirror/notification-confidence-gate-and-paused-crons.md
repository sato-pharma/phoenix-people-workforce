---
name: notification-confidence-gate-and-paused-crons
description: "The 2026-07-23 mass-email incident chain, and the Notification Confidence Gate built as the send-time guardrail — LIVE at /admin/notification-confidence with approve, discard and pending routes. The \"3 Cloud Scheduler jobs still PAUSED\" half is moot: GCP is dead and the production scheduler is cron-job.org, so do not go hunting for those jobs or read their absence as a fault."
metadata: 
  node_type: memory
  type: project
  originSessionId: ca3ff325-bc00-4df1-b856-df76870bf385
  modified: 2026-07-25T18:06:48.656Z
---

**The incident (2026-07-23, 06:37 Cairo):** a newly-deployed private-calendar "No Activity
Recorded" weekly notice (added the same day by `0b267fb1` / PR #1269) mass-flagged **92 of
~115 active employees** off one thin day of attendance data. Confirmed in production
`notification_events`: 92 rows of `private_calendar/private_calendar_no_activity_first_notice`
at 06:37:22 Cairo. This is the concrete event behind the owner's "bulk emails fire by mistake
and very hilarious issues happened on production data."

**Two fixes, both in main and live in production:**
1. **Root cause removed** — `ec3794ce` (2026-07-24, PR #1299) "remove automated no-activity
   weekly reminder email". The offending notification no longer exists.
2. **Defense in depth: the Notification Confidence Gate** — `a02bc561` (2026-07-23),
   `src/lib/notifications/confidence-gate.ts`. Every automated email passes through
   `evaluateAndRecordNotificationSend()` in `send-phoenix-email.ts` (single choke point).
   Four checks: `content_integrity` (empty fields / unresolved `{{token}}`),
   `recipient_validity`, `identity_resolved`, `fanout_anomaly`. **One failing check HOLDS the
   send outright** — deliberately not averaged, so a mass-false-positive can't be diluted by
   passing checks. Fan-out check has two modes: statistical baseline (mean + 3σ) for
   (module,eventType) pairs with ≥5 days history, and a flat ceiling of
   `min(10, 25% of headcount)` for brand-new pairs — which is exactly the incident's shape.
   Infra errors fail OPEN (never a second self-inflicted outage). Held items wait at
   **`/admin/notification-confidence`** for Super Admin approve/discard; approving re-sends
   the EXACT content that was reviewed (never re-rendered). Emergency bypass:
   `NOTIFICATION_CONFIDENCE_GATE_ENABLED=false` (disables holding, still logs).
   Audit table: `notification_send_reviews`.

**PAUSED CRONS — the live gotcha (verified 2026-07-25):** at 14:16–14:19 Cairo on 2026-07-23
(~8h after the incident) three Cloud Scheduler jobs were paused as an emergency stop and were
**still paused ~2 days later**, silently. All jobs live in **`us-central1`**, NOT
europe-west3 (the Cloud Run service's region) — `gcloud scheduler jobs list
--location=us-central1 --project=phoenix-workforce-498619`.

| Job | Schedule | State |
| --- | --- | --- |
| `phoenix-notify-daily` | `36 6 * * *` | PAUSED |
| `phoenix-process-notifications` | `*/5 * * * *` | PAUSED |
| `phoenix-background-jobs` | `0 3 * * 5` | PAUSED |
| `phoenix-ireports360-sync` / `-live-sync` / `-reconcile-visits` / `phoenix-recruitment-email-intake` | various | ENABLED |

Impact while paused: no HR daily digest, birthday, contract-renewal, probation reminder,
marketing due/escalation, vacation/outstation/resignation SLA mail; the **outbox drain is off**
so nothing queued can be delivered; Friday admin exports don't run. Proof in
`notification_events`: 12 consecutive days of ~88–103 events at 06:36 Cairo through 07-23, then
**zero** on 07-24 and 07-25.

**Why:** an emergency pause is the right first move during a live mass-send, but nothing in the
system expires the pause or reminds anyone — a silent-OFF is as dangerous as the original
mass-send, just quieter. Nothing alerted on 2 missed daily runs.

**How to apply:** whenever notification behavior looks "dead", check scheduler job **state**
first (`gcloud scheduler jobs list --location=us-central1`) before reading code — a PAUSED job
produces exactly the same symptom as broken code. Resuming is safe only once the offending
notification is removed/fixed at source; here both conditions were met (root cause deleted +
gate live, proven by 2 real holds on 07-24 17:54 Cairo). Resume needs explicit owner approval
(production behavior change). Also: `/admin/notification-confidence` has no notifier — held
items sit indefinitely (2 recruitment CV emails sat undecided ~22h), so a held-item alert is
the real remaining gap, not more send-side blocking.

**FIXES IN FLIGHT — PR #1325** (`codex/notification-safety-gate-fixes`, worktree
`F:\Phoenix Workforce\_wt-notif-safety`, branched off 77724db1, opened 2026-07-25): fixes the
`identity_resolved` bug below, adds `src/lib/notifications/held-notification-alert.ts` (Super Admin
in-app+Telegram alert on every hold, never email → no gate recursion, throttled 1/hour per
module+eventType), and makes `/api/notifications/daily` report sub-job failures truthfully
(`onJobFailure` → `logError` with `event=cron_failed`, `success: failures.length === 0`,
`failedJobs` in the response, new `event=cron_run_summary` line to alert on). Kept HTTP 200 on
partial failure — see the retryCount correction below for why the original reasoning was wrong but
the conclusion still stands. Validated: typecheck clean, lint 0 errors, 428 test files pass,
build OK. **NOT merged, crons still paused** — owner chose "leave paused, show me first".

**CORRECTION (2026-07-25, same session) — retryCount is 0, not unlimited:** I initially told the
owner (and wrote in this file) that this job's retryConfig meant "unlimited retries," based on
`maxRetryDuration: "0s"` showing in `gcloud scheduler jobs describe`. That's backwards. Cloud
Scheduler's JSON output omits zero-valued proto3 scalar fields, so `retryCount` not appearing does
NOT mean unset/unlimited — verified authoritatively via `gcloud scheduler jobs update http
--help`: *"--max-retry-attempts ... Default is 0"* and *"--max-retry-duration ... Default is 0
seconds (which means unlimited); however, if --max-retry-attempts is also 0, a job attempt won't
be retried if it fails."* All 7 jobs have `--max-retry-attempts` unset (=0 default) →
**ZERO retries, not unlimited.** So a 5xx on partial failure would NOT have caused a retry storm.
The HTTP-200 decision above still stands, just for a cleaner reason (see PR body) — but if this
project's retry config is ever intentionally changed to actually retry, re-derive the HTTP-status
decision from scratch rather than trusting the old "unlimited retries" framing anywhere it might
still be quoted.

**FIX 4 (same PR, 2nd commit c559b8fb) — attemptDeadline undercut every 300s job, LIVE APPLIED:**
5 of 7 jobs (`notify-daily`, `process-notifications`, `background-jobs`, `ireports360-sync`,
`reconcile-visits`) hit routes with `maxDuration=300` (Cloud Run service `timeoutSeconds` confirmed
300s too), but every job was silently sitting on gcloud's **180s** HTTP-target default —
`--attempt-deadline` had never been set explicitly anywhere, not a deliberate choice. Once 180s
passes, Scheduler cancels its own wait and marks the attempt FAILED even though Cloud Run keeps
executing to real completion — false-failure noise (harmless given retryCount=0, but exactly the
noise that would drown out FIX 3's new truthful failure reporting). Set to **330s** (HTTP-target
ceiling is 30 min, confirmed via docs.cloud.google.com/scheduler). The 2 jobs on 120s-max routes
(`ireports360-live-sync`, `recruitment-email-intake`) were already fine at 180s, left alone.
Applied to BOTH `scripts/setup-gcp-cron.sh` (source of truth) AND the 5 LIVE jobs directly via
`gcloud scheduler jobs update http <job> --attempt-deadline=330s --location=us-central1
--project=phoenix-workforce-498619` — this is infra config outside the app's deploy pipeline, so
unlike fixes 1-3 it took effect immediately, independent of PR merge. Verified before/after: all 5
now show 330s; schedule/timeZone/URI/headers unchanged; **the 3 paused jobs are still PAUSED**, the
2 enabled ones still ENABLED — pause state was not disturbed by the update.

**Test-guard trap:** `tests/email-notifications.test.ts` pinned the BROKEN
`console.error(e, { tags: { cron: "daily-birthday" } })` string under the false label "errors must
be captured in Sentry with tags". Editing the route fails the suite until that assertion is
replaced. Also: an explanatory code comment quoting that literal will trip the new
`doesNotMatch(/console\.error\(e, \{ tags:/)` guard — word it without the exact literal.

**GATE BUG — `identity_resolved` holds legitimate mail (verified 2026-07-25, fixed in PR #1325):**
`checkIdentityResolved` (`confidence-gate.ts:178-184`) returns `passed: status === "verified"`,
so the legitimate status **`not_required`** (an email with no subject employee) scores as a
FAILURE — and one failure holds the send. Both production held rows are exactly this: 3/4 checks
green, `fanout_anomaly` PASSED, held only on `identity_resolved` = "Recipient identity status:
not_required", confidence 75%. Perverse shape: supplying NO identityStatus returns
`passed: null` (no penalty, sends fine), but honestly reporting `not_required` blocks it. Once
the crons resume this will hold/eventually-drop every no-subject-employee notification
(recruitment, digests). Fix = treat `not_required` as pass (or null), keep only genuinely
unresolved/failed identities as a failure.

**Second gate weakness:** `classifyOutboxSkip` (`notifications/email.ts:1352-1392`) does not match
"Held for Super Admin review", so a hold is non-terminal → retried at +5/+15/+60/+240 min. For a
*fan-out* hold the 15-min burst window is empty by the +60 min retry, so the check passes and the
mail **sends anyway** — the fan-out gate is a delay, not a block. For an *identity* hold it fails
all 5 attempts and is dropped. Both outcomes are wrong.

**Staging is SAFE (checked, don't re-raise this alarm):** `phoenix-hr-staging` sets
`APP_ENV=staging`, so `isProductionRuntime()` is false → `isForceTestingDelivery()` returns true
→ all staging mail redirects to `PHOENIX_EMAIL_TEST_RECIPIENTS`
(omar.anwar@satopharma.com, achieverrr303@gmail.com). `PHOENIX_EMAIL_FORCE_TESTING` is absent but
not needed. Staging never emails real employees.

**Observability hole (bigger than the gate):** `/api/notifications/daily` runs 22 sub-jobs, each
with its own `.catch()`, then returns HTTP 200 `{success:true}` — so Cloud Scheduler logs SUCCESS
and the `notifications-daily` Sentry monitor checks in OK **even if all 22 failed**. 18 of the 22
catch handlers use bare `console.error(e, {tags})` (no `logError`, no `event=cron_failed` label,
and the `tags` arg is dead) → they match no log metric and no alert. There is also **no
cron-run history table** anywhere (searched migrations for cron_run/job_run/last_run_at).
De-facto early warning today = every automated email is unconditionally BCC'd to
omar.anwar@satopharma.com (`send-phoenix-email.ts:256-259`).

**UI email kill switch:** pausing `phoenix-process-notifications` at `/admin/cron-control` stops
the outbox drain in ~2 clicks — the practical panic button, but it is documented nowhere. A true
global switch (`EMAIL_NOTIFICATIONS_ENABLED=false`) is CLI/Cloud-Run-only. In-request direct
sends (vacation, interview, direct-orders, SoS delivery) bypass the outbox and keep going.

**The 07-16 probation flood (owner's "116 wrong emails"), verified:** 2026-07-16 Omar Anwar Gawish
(B-10) got **60 probation emails with only 2 distinct subjects (58 pure duplicates)**; PHX-1 also
60; Ahmed Abdallah (B-74) 24 emails/4 subjects on both 07-15 and 07-16; Sally Saeed (B-184) 16.
Fixes: `PROBATION_DAILY_NOTIFICATION_CAP = 2` per recipient per Cairo day
(`probation/intelligence/notification-cap.ts`, 2026-07-17, PHX-1 exempt, fails open) plus PR #1259
consolidation. Probation does NOT use `createSystemNotificationForRecipients` (only outstation,
vacation, recruitment do) — it loops `createSystemNotification` with explicit recipientHrId, which
by design bypasses governance resolution (see the scope-leak comment at `probation/service.ts:541`,
a THIRD incident: 07-19, up to 98 users company-wide got other lines' probationers). **None of
these probation fixes has been exercised in production** — the crons paused 07-23, the same day.

**Ongoing noise (not email):** `marketing_requests/escalation` emits exactly **85 in-app events
every morning** — 85 marketing requests stuck in `pending_approval` with due dates back to
January 2026, re-escalating forever. Only ~1 becomes an email/day, so it is in-app clutter, not
mail spam. Real fix is closing/archiving the 85 stale requests.

**FIX 5 (same PR, 3rd commit 7e5b0938) — external dead-man's-switch, NEEDS OWNER ACCOUNT SETUP:**
new `src/lib/observability/dead-mans-switch.ts`, wired into all 7 cron routes (`withDeadMansSwitch`
wrapper for 6; `daily/route.ts` calls `pingDeadMansSwitch` directly so a partial sub-job failure —
which never throws by design — still pings `/fail`). Uses Healthchecks.io's Ping Key + slug API
(one secret `HEALTHCHECKS_PING_KEY` covers all 7 jobs, slug = live GCP Scheduler job name,
`?create=1` auto-provisions each check on first ping — no manual per-check UUID setup). Complete
no-op (zero network attempts, verified in `tests/dead-mans-switch.test.ts`) outside production or
whenever the key is unset; never throws; never masks the real job's own success/failure. **I
cannot create the Healthchecks.io account** (hard rule — creating accounts is prohibited for any
AI session) — owner must: create account → Settings → copy Ping Key → set
`HEALTHCHECKS_PING_KEY` on `phoenix-hr` Cloud Run (separate prod-env-var approval, NOT done) →
configure a notification channel → optionally retune each auto-created check from the generic
1-day-period default to the exact Cron expression + grace table now in
`docs/observability.md`'s new "External dead-man's-switch" section (also lists per-job:
notify-daily 1h grace, process-notifications 10m, background-jobs 2h, ireports360-sync 30m,
reconcile-visits 2h, ireports360-live-sync 15m, recruitment-email-intake 10m). Also fixed
`docs/observability.md`'s stale "all 6 GCP-scheduled cron routes" → 7 (recruitment-email-intake
added 2026-07-24, never updated there). New env vars documented in `.env.example` +
`docs/environment.md`: `HEALTHCHECKS_PING_KEY` (required to activate), `HEALTHCHECKS_PING_HOST`
(optional, self-hosted override). Validated: typecheck clean, lint 0 errors, 429 test files pass
(428 + new test), build OK. This 3rd commit was added to the SAME branch/PR as fixes 1+4 rather
than a separate PR — origin/main had drifted further mid-session with unrelated merges from other
sessions, and only `daily/route.ts` overlapped with the already-pushed commits, so extracting a
clean separate diff wasn't worth the risk vs. just continuing the same PR.

**PR #1341 MERGED 2026-07-25** (mass-BCC recipient-volume guard) — production deploy in
flight, queued behind another session's PR #1346.

Related: [[notification-duplicate-email-fanout-fix]], [[resend-daily-100-cap-429-outage]],
[[notification-outages-cloudrun-env-drift-2026-07-11]], [[private-calendar-plan-sync-removed]],
[[system-issues-dashboard-gcp-supabase]], [[prod-verify-region-europe-west3]].

## 2026-09-04 — the gate is live; the paused-jobs half is dead infrastructure

**The guardrail is real and serving.** `app/(admin)/admin/notification-confidence/page.tsx`, plus
`app/api/admin/notification-confidence/route.ts` and its `pending`, `[id]/approve` and
`[id]/discard` routes. (A first search for "confidence gate" returned nothing and nearly led me
to report it missing — the code spells it `notification-confidence`. Search the hyphenation, not
the prose name.)

**The three paused Cloud Scheduler jobs are no longer a meaningful state.** `AGENTS.md` §3: GCP
is dead, not standby — billing is closed and every API in `phoenix-workforce-498619` returns
`BILLING_DISABLED`. The production scheduler is the third-party cron-job.org. So whether those
three jobs are paused changes nothing, and a session should not un-pause them, look for them, or
treat their state as evidence about notification delivery.

The incident chain itself is the durable part, and it is why the standing rule *never fire bulk
or test emails* exists.
