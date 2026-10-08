---
name: the-recovery-snapshot-cron-is-hand-made-state
description: "Production's hourly recovery.take_snapshots() schedule is in a migration since 2026-10-08 and is safe to re-apply because cron.schedule BY NAME updates the one job instead of stacking a second hourly caller — it was hand-made state until then, which is why a restored database came back with the undo log deployed and never running"
metadata:
  node_type: memory
  type: project
  originSessionId: 97c951c0-99ab-4f3a-a221-16fbb9be8f3a
  modified: 2026-10-08T11:08:07.019Z
---

Production has **no point-in-time recovery**; the hourly `recovery.take_snapshots()` store is what
stands in for it (7 protected tables: `public.employees`, `salary_records`, `salary_batches`,
`monthly_closing_locks`, `monthly_closing_publications`, `au.monthly_targets`,
`au.line_area_map`). Measured healthy on 2026-10-08 — cron job `phoenix-recovery-snapshot` at
`5 * * * *`, **206 runs, every one `succeeded`**, all 7 captured.

🔴 **Nothing in `supabase/migrations/` created that schedule until 2026-10-08** — the retention job
beside it always was (`20261004041000`), but this one had been made by hand, so a restored,
recreated or region-moved database came back with the store **deployed and never running**: the
exact "looks like protection" state its own dead-man's switch exists to catch.

**Closed on his instruction, 2026-10-08:
`20261008140000_schedule_recovery_snapshot_cron.sql`.** Two properties make re-applying it safe on
a live production, and both are pinned by `tests/schema-shape-recovery-health.test.ts`:
**it schedules BY NAME**, so `cron.schedule` updates the job of that name rather than stacking a
second hourly caller (verified: one job before and after, **jobid 1 preserved**, all 206
`cron.job_run_details` rows intact — that table is keyed by jobid, which is what preserves the
history), and **it is guarded on `pg_extension`**, so it warns instead of failing where `pg_cron`
is absent — which matters beyond tidiness, because a failing `staging-migrate` withholds the
production deploy. It does **not** install the extension.

**Staging has never run it at all** — `pg_cron` is not installed there, so `cron.job` does not
exist, `recovery.snapshot_runs` holds 0 rows and all 7 tables read 0 snapshots. That is what the
nightly `migration-drift-check` reports; it is **staging-only and not a production fault**, though
the finding's wording made it sound like one. The migration applies cleanly there and skips, so
where `pg_cron` is absent the schedule is still missing — now the one reachable way into
`recovery_never_ran`, which is why that verdict says to install `pg_cron` and re-apply rather than
to schedule by hand. **Whether staging should run the store at all is still an open decision of
his** — it needs `pg_cron` enabled there, and staging holds no real payroll.

**A snapshot is written only when a table's contents CHANGE**, so one snapshot, or an old
`newest_snapshot_at`, is normal and healthy per table — `check-schema-shape.ts` judges staleness on
the newest capture across *all* of them, never one. `salary_records` holding a single snapshot from
the day the store shipped is correct, not a gap.

Since #5498 the gate separates the two causes: `recovery_never_ran` when **every** enabled table is
uncaptured (it has never been *called* — look at `pg_cron` and `cron.job`), and
`recovery_table_never_captured` when only some are (the scheduler is up, so read
`recovery.snapshot_runs.error`). Before that, one message sent you to `snapshot_runs.error` on a
target where that table is empty. Pinned by `tests/schema-shape-recovery-health.test.ts`.

See also [[a-skipped-ci-step-is-0001-01-01-not-null]] for the other half of why that nightly's
findings go unread: its job concludes **green by design** (`continue-on-error` plus an `::error::`
annotation, so it can never withhold a production deploy), and four legs were exiting 1 unnoticed.
