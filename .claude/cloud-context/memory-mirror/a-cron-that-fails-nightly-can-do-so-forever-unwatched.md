---
name: a-cron-that-fails-nightly-can-do-so-forever-unwatched
description: "A red GitHub Actions scheduled run alerts NOBODY here — nine consecutive nightly failures went unseen; only the Healthchecks dead-man's-switch (wired into the ROUTE, not the workflow) reports a cron that stopped"
metadata: 
  node_type: memory
  type: project
  originSessionId: 95a9153c-7cad-40ba-8918-05de11f9c69f
  modified: 2026-08-23T12:39:44.114Z
---

**A red scheduled-workflow run is not an alert in this repo.** Proven 2026-08-23.

`.github/workflows/direct-orders-sweeps.yml` failed **nine nights running** (2026-08-14 → 08-22),
both steps, identical `HTTP 401`. Its own comment claimed *"it fails loudly: a red workflow run
emails the owner."* It did not, or nobody reads those mails — the failure surfaced only because an
unrelated Direct Orders audit went looking at `gh run list`. **Do not trust that claim about any
workflow here; it was removed and is now CI-pinned against being re-added.**

**What DOES report a dead cron: the Healthchecks.io dead-man's-switch**
(`src/lib/observability/dead-mans-switch.ts`, `HEALTHCHECKS_PING_KEY`, still alive post-GCP). It
alerts on the ping that **did not arrive**, so it is the only mechanism that can report *the request
never reached the handler* — a 401, a deleted schedule, a paused job. Wire it in the **route**:

```ts
const result = await withDeadMansSwitch("phoenix-<job>", () => doTheWork());
```

Wrap the **whole unit of work**, including any report/email the job exists to send — a sweep that
finds something and then fails to deliver it has not run.

**Coverage is COMPLETE as of 2026-08-23, and the last two gaps are unwired ON PURPOSE.**
Of the routes in `app/api/cron/`: `db-health-snapshot` opts out **with a comment saying so**;
`direct-orders-expire-held` + `direct-orders-probation` wrapped by PR #2316;
`run-synthetic-journeys` by #2321; and **#2322 (merged, live `e357f99d`) wired the last three by
CREATING THE SCHEDULES THEY NEVER HAD** — see
[[sheet-token-rotations-had-no-schedule-for-18-days]] and
[[a-wired-healthchecks-slug-does-not-mean-anything-calls-the-route]]. The two still unwatched:

- `marketing-assignment-backfill` — on-demand escape hatch; the same sweep already runs as a daily
  sub-job, so it is covered by `phoenix-notify-daily`.
- `reconciliation-check` — wired to a slug but called by nothing; read-only, harmless.

Before wiring any cron route, confirm it runs on a fixed schedule: an auto-provisioned check
defaults to 1-day period / 1-hour grace, so an ad-hoc job goes permanently red and trains everyone
to ignore the dashboard. Schedules live only in cron-job.org, but you can **read them directly over
its REST API** rather than inferring a cadence —
[[cron-job-org-is-managed-by-a-rest-api-not-just-the-web-ui]]. Fall back to
[[railway-http-logs-only-cover-the-current-deployment]] only when the account is unreachable.

**Both Direct Orders clocks moved into cron-job.org on 2026-08-23** (jobs `8313165` at 02:17 and
`8313177` at 02:27, Africa/Cairo), so the sentence above about them being scheduled from a workflow
is history: `.github/workflows/direct-orders-sweeps.yml` now has `workflow_dispatch` and **no
`schedule:`**, and a CI test fails if one is re-added — two schedulers would double-notify every
requester whose order expires.

**`withDeadMansSwitch` is not always right.** It derives the ping from throw/no-throw, so a route
that answers HTTP 200 on a real failure (`run-synthetic-journeys` returns `{dispatched:false}` when
GitHub refuses) would ping SUCCESS. For those, call `pingDeadMansSwitch(slug, ok ? "success" :
"fail", detail)` directly — the idiom `notifications/daily` already uses.

Auto-provisioning (`?create=1`) means the check appears in Healthchecks on its **first successful
ping** — carrying Healthchecks' OWN defaults (1-day period, 1-hour grace), which are wrong for almost
every job here. Do not fix that in the dashboard: edit the row in `docs/observability.md` and run
**`pnpm run healthchecks:sync --apply`** — [[healthchecks-schedules-are-synced-from-the-doc-table]],
which also explains why the ping key cannot do it.

Related: [[github-actions-cron-secret-went-stale-after-a-railway-rotation]] (what broke),
[[error-monitor-hides-null-environment-rows]], [[ci-jobs-failing-in-seconds-means-billing-not-code]].

---

**The OTHER half of this failure mode, found 2026-08-23: an alert that IS delivered and IS
ignored.** `.github/workflows/migration-drift-check.yml` is the counter-example to everything
above — it has a real `Notify Telegram on failure` step, and that step **worked perfectly for 13
consecutive nights**. Every run since 2026-08-11 logged `telegram sendMessage HTTP 200` /
`Telegram alert delivered.`, step conclusion `success`. Last green run: 2026-08-10.

So the alarm was not the problem. The **content** was: the same message, every night, naming the
same 29 files, with no way to tell from the text that 22 of them were bookkeeping noise and only 7
were real. A nightly alert that cannot change its own headline stops being read by about day three.

**How to apply:** when you find a workflow red for many days, check whether its alert *fired*
before concluding nothing warned anyone — `gh run view <id> --log` and grep the notify step. If it
did fire, the fix is never "add an alert"; it is to make the check stop crying wolf (reconcile the
known-good cases so a flag means something) or to make the message carry a delta. Do **not** silence
it by adding the failing item to an exceptions list unless you have catalog proof it is genuinely
fine — see [[list-migrations-reports-ledger-not-reality]].
