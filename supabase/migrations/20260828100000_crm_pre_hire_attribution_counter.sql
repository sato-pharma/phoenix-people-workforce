-- Persist the PRE-HIRE attribution block count on each iReports360 sync run.
--
-- WHY. The employment-span guard in resolveEmployeeAttribution now refuses a visit dated before the
-- resolved employee's hire date, not just one dated after their last working day. Both refusals come
-- from the same cause — whoever administers iReports360 hands a departing rep's CRM account to their
-- replacement instead of creating a new one — but they are NOT the same operational event:
--
--   post-exit  the replacement's CURRENT work is going unattributed today. Act now.
--   pre-hire   the PREVIOUS occupant's history is detaching from the new joiner. A backfill to
--              reconcile, not an emergency.
--
-- Counting them together would let a burst of old rows drown out a live problem, and vice versa, so
-- they get separate columns rather than one "blocked" total.
--
-- WHAT IT WILL SHOW ON ITS FIRST RUNS. Measured on production 2026-08-28, before this guard existed:
-- 1,619 mirror rows (1,114 of them real doctor calls, across 34 employees) were attributed to
-- somebody dated before they joined, the largest single case being 931 real calls dated up to 207
-- days before that employee's hire date. 504 of those rows fall inside the 120-day wide-reconcile
-- window, so this counter will read non-zero on the reconcile slices that cover them and then settle.
-- A steady non-zero AFTER that settling means a newly handed-over account, which is the signal.
--
-- WHY THE GUARD IS DATE-ONLY AT THIS END. The post-exit half is decided by comparing the record's
-- CRM label against the employee's own, which separates a handed-over slot from someone's final days
-- logged late. That test cannot work here: the CRM REWRITES the label on historic rows when an
-- account changes hands, so 1,248 of those 1,619 rows (77%) carry the CURRENT holder's own label and
-- a label test would allow them. See isAttributableOn's doc comment for the full gap distribution.
--
-- SHAPE. Matches the five counters already on this table (rows_deleted, rows_fetched,
-- rows_skipped_invalid_date, rows_skipped_reconcile, blocked_post_exit_attributions):
-- integer NOT NULL DEFAULT 0.
--
-- DEPLOY ORDER — APPLY THIS BEFORE THE CODE THAT WRITES IT.
-- The column is additive with a default, so it is safe in BOTH directions for the currently deployed
-- code: today's sync simply does not mention the column and the default fills it in. The reverse
-- order is NOT safe — code that writes `blocked_pre_hire_attributions` against a table without it
-- makes the sync-run update fail, and that update is what marks a run "success", so every sync would
-- look failed while actually having written its rows perfectly well.
--
-- Backfill is deliberately NOT attempted, same as the post-exit column: the value was never captured
-- for historical runs, and 0 is the honest default for "not measured" here because it is also the
-- healthy value. Rows predating this migration should be read as "unknown", not "verified clean".

alter table public.ireports360_visits_sync_runs
  add column if not exists blocked_pre_hire_attributions integer not null default 0;

comment on column public.ireports360_visits_sync_runs.blocked_pre_hire_attributions is
  'Visits this run refused to attribute because the CRM account resolved to an employee whose hire date is AFTER the visit date (see resolveEmployeeAttribution). Almost always the previous occupant of a handed-over CRM account, whose history the vendor has relabelled with the new joiner''s name — those rows need an identity override pointing at whoever really did the work. Rows created before 2026-08-28 carry 0 because the value was not captured then — read those as unknown, not as verified clean.';
