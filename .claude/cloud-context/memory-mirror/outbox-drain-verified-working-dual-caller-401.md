---
name: outbox-drain-verified-working-dual-caller-401
description: "Outbox drain CONFIRMED working 2026-08-02 05:25 Cairo (process -> 200); a second stale caller 401s every cycle and is a double-fire hazard"
metadata: 
  node_type: memory
  type: project
  originSessionId: b97ef79e-b43d-4c90-9bd4-88f5626ee922
  modified: 2026-08-02T02:26:11.097Z
---

**The notification outbox drain IS running and succeeding.** Verified 2026-08-02 05:25
Cairo from `railway logs --http` on the app service:

    GET /api/notifications/process   401  12ms
    GET /api/notifications/process   200  14813ms
    GET /api/cron/inbound-intake     200  838ms
    GET /api/cron/inbound-intake     401  10ms
    GET /api/cron/recruitment-email-intake  200  678ms
    GET /api/cron/recruitment-email-intake  401  15ms

**Every cron endpoint is hit TWICE — once 401, once 200.** Two schedulers are live: one
authenticates correctly, one does not (the stale GCP Cloud Scheduler, whose secret does
not match Railway's `CRON_SECRET` — see [[railway-migration-live-topology-and-cli]]).
A 401 line alone therefore proves nothing about cron health; you must look for the
matching 200. Reading only the 401 is what makes the crons look dead when they are not.

🔴 **Double-fire hazard.** If anyone ever makes the two secrets match, every job fires
twice — the outbox overlap guard is an in-process lock, not a DB lock. Do not "fix" the
GCP secret to silence the 401s; disable those jobs instead.

**Queue state at the same moment (prod `ozucdzovmcqvepbozvqf`):** zero `pending`; zero
rows eligible for the drain; 26 `failed` all sitting at `attempts = max_attempts = 5`
(correctly exhausted, last touched 07-13). **No backlog.** Note this means an empty
queue is NOT evidence the drain works — check the HTTP 200, not the row count.

🔴 **66 rows are terminally `skipped` and unrecoverable.** `skipped` is terminal — the
drain only re-reads `pending`/`failed`. Two of them were created during the GCP→Railway
cutover window (08-01 23:02 and 08-02 00:26 Cairo) with
`[email_disabled_globally] EMAIL_NOTIFICATIONS_ENABLED is not true`. That cause is now
FIXED — `/api/health/email` reports all 7 vars present, `deliveryMode: live`,
`forceTesting: false`, `status: healthy` — but the 66 notifications are lost unless
someone requeues them to `pending`. Last successful send was 08-01 18:00 Cairo; the
silence since is explained by nothing sendable being enqueued, not by a broken drain.

**Why:** two sessions in a row concluded "the crons are dead" from partial evidence —
first from `BILLING_DISABLED` on the GCP management API, then from a 401 line. Both were
wrong in opposite directions.

**How to apply:** to judge cron health, run `railway logs --http` (link from a scratch
dir first — `logs` has no `-p` flag) and look for a **200** per endpoint. To judge the
outbox, query `notification_outbox` grouped by status and check
`attempts < max_attempts AND next_attempt_at <= now()` for genuinely-stuck rows.
Verification endpoints that actually prove state: `/api/readyz` (returns the serving
`revision`), `/api/health/email`.
