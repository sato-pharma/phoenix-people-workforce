-- Persist the post-exit attribution block count on each iReports360 sync run.
--
-- WHY. The sync already computes how many visits the post-exit guard refused to attribute — a CRM
-- account resolving to someone who had already left on the day the work happened, which is the
-- recurrence signal for the invisible-work bug class that hid 1,542 visits until 2026-08-01. But
-- that number only ever reached the Telegram / in-app digest. Nothing recorded it, so the single
-- most useful "is the identity waterfall still healthy" metric could not be queried after the fact,
-- trended, or checked by anyone who was not watching notifications at the moment a sync ran.
--
-- Verifying the guard's behaviour in production currently means catching a notification live. That
-- is not a check anyone will actually perform, which makes it not a check at all.
--
-- SHAPE. Matches the four counters already on this table (rows_deleted, rows_fetched,
-- rows_skipped_invalid_date, rows_skipped_reconcile): integer NOT NULL DEFAULT 0.
--
-- DEPLOY ORDER — APPLY THIS BEFORE THE CODE THAT WRITES IT.
-- The column is additive with a default, so it is safe in BOTH directions for the currently
-- deployed code: today's sync simply does not mention the column and the default fills it in. The
-- reverse order is NOT safe — code that writes `blocked_post_exit_attributions` against a table
-- without it makes the sync-run update fail, and that update is what marks a run "success", so
-- every sync would look failed while actually having written its rows.
--
-- Backfill is deliberately NOT attempted: the value was never captured for historical runs, and
-- 0 is the honest default for "not measured" here because it is also the healthy value. Rows
-- predating this migration should be read as "unknown", not as "verified clean" — the column
-- comment below says so.

alter table public.ireports360_visits_sync_runs
  add column if not exists blocked_post_exit_attributions integer not null default 0;

comment on column public.ireports360_visits_sync_runs.blocked_post_exit_attributions is
  'Visits this run refused to attribute because the CRM account resolved to an employee whose last working date precedes the visit date (see resolveEmployeeAttribution). >0 means a CRM account was probably handed to a replacement and needs an identity override, or the new rep''s work goes invisible. Rows created before 2026-08-01 carry 0 because the value was not captured then — read those as unknown, not as verified clean.';
