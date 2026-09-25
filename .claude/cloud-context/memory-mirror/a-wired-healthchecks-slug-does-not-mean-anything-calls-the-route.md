---
name: a-wired-healthchecks-slug-does-not-mean-anything-calls-the-route
description: "A dead-man's-switch slug in a cron route proves only that the app WOULD ping — 2 routes are wired and called by nothing at all, and 4 iReports360 cron jobs are OFF on purpose because the in-process poller pings the same slugs"
metadata:
  node_type: memory
  type: project
  modified: 2026-08-23T08:00:00.000Z
---

**Reading `withDeadMansSwitch("phoenix-x")` in a route tells you nothing about whether that job
runs.** The slug says the app would ping *if something called it*. Whether anything does lives in
the cron-job.org account, which git cannot see. Verified against the live account 2026-08-23:
**17 jobs, 12 enabled** ([[cron-job-org-is-managed-by-a-rest-api-not-just-the-web-ui]] has the API).

**Wired and called by NOTHING — no cron job, no workflow:** `/api/cron/reconciliation-check` →
`phoenix-reconciliation-check`. Read-only, harmless — but do not read its slug as evidence anything
is reconciled on a cadence.

**`/api/cron/brevo-keepalive` was the same until 2026-08-23 — now cron-job.org job `8313297`,
`9 4 1 * *` (04:09 Cairo on the 1st).** Its check had **never been created**: auto-provisioning needs
a first ping, so a job that never runs produces SILENCE, not red. It resets Brevo’s 90-day
inactivity expiry on the email **FAILOVER** key — the one that must work on the day the primary
doesn’t. A one-shot probe on 2026-08-23 returned `{"success":true,"status":"ok","account":
"phoenixx.oag@gmail.com"}` in 2686 ms, so **the key had NOT expired**, and that ping also created
the check. Monthly = 3 pings per 90-day window. The route already used `withDeadMansSwitch`
correctly (a rejected key throws on purpose); only the schedule was missing.

**Four iReports360 cron jobs are DISABLED ON PURPOSE — do NOT "fix" them by switching them on.**
`phoenix-ireports360-sync`, `phoenix-ireports360-reconcile`, `phoenix-reconcile-visits`,
`phoenix-ireports360-live-sync`, all last fired **2026-08-16**. PR #1631 moved that work into
`src/lib/crm/live-poller.ts` (in-process, `instrumentation.ts`, `PHOENIX_LIVE_CRM_POLL=true`), and
**the poller pings the same slugs** — `phoenix-ireports360-sync` and `phoenix-reconcile-visits` when
their deep runs come due, plus its own `phoenix-ireports360-live-poll` every tick. Re-enabling the
cron jobs would double every sync. `phoenix-inbound-intake (Copy)` is a 5th disabled job — an
accidental duplicate; enabling it would double every intake run.

**The one genuinely broken check: `phoenix-ireports360-live-sync` has been red since 2026-08-16 for
no reason at all.** Nothing else pings that slug and its only job is off. `docs/observability.md`
was still telling the owner to give it a 15-minute schedule. Delete the check.

**Poller-pinged checks cannot use the old cron rows.** The poller fires on an ELAPSED-TIME guard,
not a wall clock: rolling sync ≥3h since last success and not before 06:00 Cairo; wide reconcile
≥5.5 days and Sunday from 04:00. The GCP-era rows (`7 9,12,19 * * *` @30m, `24 4 * * 0` @2h) go red
daily — a poller sync at 09:00 does not satisfy a check expecting one after 09:07.

**The check-slug table in `docs/observability.md` now carries a "what actually pings it" column**,
and every row is traced to a cron-job.org job id or to the code that pings it. Trust that column,
re-verify it, and never add a row without one.

**YOU CAN NOW READ CHECK STATE — `HEALTHCHECKS_API_KEY` is in `.env.local` (owner created it
2026-08-23, full-access project key).** That was impossible before: only `HEALTHCHECKS_PING_KEY`
existed, and a ping key CANNOT read — it can create a check but not set its schedule, which is why
every check sat on defaults. Read all checks with
`curl -H "X-Api-Key: $KEY" https://healthchecks.io/api/v3/checks/` — `n_pings` and `last_ping` are
the only honest proof a route is really watched. **Never probe by SENDING a ping**: that writes a
fake run into the production check history.
Sweep 2026-08-23 19:46 Cairo: **15 checks, 13 `up`, 0 down**; `pnpm run healthchecks:sync` said
*"Everything already matches"* (schedules/timezone/grace all correct — do NOT expect a wall of red).
`my-first-check` is the leftover Healthchecks sample, 0 pings, not ours — safe to delete.
**Four routes were proven by hand that day** (owner approved each), all `n_pings` 0→1 except brevo:
both sheet-token rotations (14:00), brevo-keepalive (15:14), direct-orders-probation (19:46).
**`cron/direct-orders-probation` WRITES and can EMAIL** — it promotes provisional pharmacies to
`trusted` and mails the owner AND the CEO a report naming pharmacies, values and the REP, but only
when `flagged.length > 0`. Check first: it flags only `trust_state='provisional' AND active` rows
whose `probation_started_at <= now() - 90 days`. On 2026-08-23 all 3 were 4 days old, so
`flagged: 0` and no mail could fire. Never trigger it blind.

Related: [[a-cron-that-fails-nightly-can-do-so-forever-unwatched]] (why the switch exists at all),
[[sheet-token-rotations-had-no-schedule-for-18-days]].
