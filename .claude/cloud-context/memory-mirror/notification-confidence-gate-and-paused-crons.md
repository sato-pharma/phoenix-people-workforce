---
name: notification-confidence-gate-and-paused-crons
description: "The 2026-07-23 mass-email incident (a new no-activity weekly notice flagged 92 of ~115 employees off one thin day of data — why the never-fire-bulk-emails rule exists), and the Notification Confidence Gate built as the send-time guardrail: LIVE at /admin/notification-confidence, every automated email passes evaluateAndRecordNotificationSend, ONE failing check HOLDS the send. The 'paused Cloud Scheduler jobs' half is DEAD infra (GCP is dead, the scheduler is cron-job.org) — do not hunt those jobs or read their state as a fault."
metadata: 
  node_type: memory
  type: project
  originSessionId: ca3ff325-bc00-4df1-b856-df76870bf385
  modified: 2026-09-26T11:13:20.601Z
---

**The incident (2026-07-23):** a newly-deployed private-calendar "No Activity Recorded" weekly notice
mass-flagged **92 of ~115 active employees** off one thin day of attendance data — the concrete event behind
the owner's "bulk emails fire by mistake." Root cause REMOVED (the automated no-activity weekly reminder no
longer exists — do NOT rebuild it, [[private-calendar-plan-sync-removed]]). This is the incident behind the
standing rule [[never-fire-bulk-emails-ever]].

## The Notification Confidence Gate (LIVE — the durable guardrail)

`src/lib/notifications/confidence-gate.ts` — every automated email passes through
`evaluateAndRecordNotificationSend()` in `send-phoenix-email.ts` (the single choke point). Four checks:
`content_integrity` (empty fields / unresolved `{{token}}`), `recipient_validity`, `identity_resolved`,
`fanout_anomaly`. 🔴 **One failing check HOLDS the send outright — deliberately NOT averaged**, so a
mass-false-positive can't be diluted by passing checks. The fan-out check has two modes: a statistical
baseline (mean + 3σ) for (module,eventType) pairs with ≥5 days of history, and a flat ceiling of
`min(10, 25% of headcount)` for brand-new pairs (exactly the incident's shape). **Infra errors fail OPEN**
(never a self-inflicted second outage). Held items wait at **`/admin/notification-confidence`** (page +
`route.ts` with `pending` / `[id]/approve` / `[id]/discard`) for Super Admin approve/discard; approving
re-sends the EXACT reviewed content, never re-rendered. Audit table `notification_send_reviews`. Emergency
bypass: `NOTIFICATION_CONFIDENCE_GATE_ENABLED=false` (disables holding, still logs). (Search the hyphenated
`notification-confidence`, not the prose "confidence gate" — a search on the name nearly reported it missing.)

**Held-notification alert:** `src/lib/notifications/held-notification-alert.ts` sends a Super Admin
in-app + Telegram alert on every hold — **never email** (no gate recursion), throttled 1/hour per
module+eventType. (This closed the earlier "held items sit indefinitely, no notifier" gap.)

## Two gate bugs — were fixed; verify current behaviour before trusting

- **`checkIdentityResolved` held legitimate mail:** it returned `passed: status === "verified"`, so the
  legitimate status **`not_required`** (an email with no subject employee) scored as a FAILURE and held the
  send — perversely, supplying NO identityStatus passed (`null`, no penalty) while honestly reporting
  `not_required` blocked. Fix = treat `not_required` as pass/null, hold only genuinely unresolved/failed
  identities.
- **`classifyOutboxSkip` didn't recognise a hold as terminal** — a "Held for Super Admin review" was retried
  at +5/+15/+60/+240 min, so a FAN-OUT hold's burst window emptied by the +60 min retry and the mail **sent
  anyway** (a delay, not a block), while an IDENTITY hold burned all 5 attempts and was dropped. Both wrong.

## Reusable lessons

- 🔴 **A test can PIN A BROKEN string** — `email-notifications.test.ts` asserted the broken
  `console.error(e, { tags: { cron: … } })` under the false label "errors captured in Sentry with tags", so
  fixing the route fails the suite until the assertion is replaced (and an explanatory comment quoting that
  literal trips a `doesNotMatch` guard).
- **The observability hole:** `/api/notifications/daily` runs ~22 sub-jobs each with its own `.catch()`, then
  returns HTTP 200 `{success:true}` even if all 22 failed — so a scheduler logs SUCCESS and a monitor checks
  in OK on total failure; the bare `console.error(e, {tags})` catches match no log metric (the `tags` arg is
  dead), and there is no cron-run history table. The fix reports sub-job failures truthfully (`onJobFailure` →
  `logError` with `event=cron_failed`, `failedJobs` in the response) while keeping HTTP 200 on partial
  failure.
- **Staging is SAFE — don't re-raise this alarm:** `phoenix-hr-staging` sets `APP_ENV=staging`, so
  `isProductionRuntime()` is false → `isForceTestingDelivery()` true → all staging mail redirects to
  `PHOENIX_EMAIL_TEST_RECIPIENTS`. Staging never emails real employees.
- **The email kill switches:** pausing `phoenix-process-notifications` at `/admin/cron-control` stops the
  outbox drain in ~2 clicks (the practical panic button); a global `EMAIL_NOTIFICATIONS_ENABLED=false` is
  CLI/env-only. 🔴 **In-request direct sends (vacation, interview, direct-orders, SoS delivery) BYPASS the
  outbox** and keep going regardless.
- **Probation-flood context:** `PROBATION_DAILY_NOTIFICATION_CAP = 2` per recipient per Cairo day
  (`probation/intelligence/notification-cap.ts`, PHX-1 exempt, fails open). Probation loops
  `createSystemNotification` with an explicit recipientHrId, which by design BYPASSES governance resolution
  (a scope-leak that once mailed other lines' probationers company-wide) — unlike outstation/vacation/
  recruitment, which use `createSystemNotificationForRecipients`.
- **Stale pending marketing requests re-escalate forever** (`marketing_requests/escalation` emits dozens of
  in-app events every morning off long-overdue `pending_approval` rows) — the real fix is closing/archiving
  the stale requests, not more send-side blocking.

## The paused-crons half is DEAD infrastructure

During the incident, three Cloud Scheduler jobs were paused as an emergency stop. **GCP is now dead** (billing
closed, every `phoenix-workforce-498619` API returns `BILLING_DISABLED`) and the production scheduler is the
third-party **cron-job.org**, so those jobs' paused state changes nothing — do NOT hunt for them, un-pause
them, or read their absence as a fault. The one durable lesson from that episode: an emergency pause with
nothing to expire it or alert on it is a silent-OFF, as dangerous as the original mass-send. When notification
behaviour looks "dead", check the SCHEDULER's job state before reading code — a paused job produces the same
symptom as broken code. Related: [[notification-duplicate-email-fanout-fix]], [[resend-daily-100-cap-429-outage]].
