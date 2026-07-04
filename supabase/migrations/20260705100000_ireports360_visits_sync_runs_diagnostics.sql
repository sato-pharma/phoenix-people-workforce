-- Visits Report accuracy fixes (2026-07-05): syncIReports360Visits now reconciles deletions
-- (a visit voided/deleted in the CRM within the synced window is removed from the mirror) and
-- filters out any visit with a missing/invalid CRM visitDate rather than letting one bad record
-- abort its whole 500-row chunk. These new columns make both effects visible in the Sync Status
-- panel instead of silent.

alter table public.ireports360_visits_sync_runs
  add column if not exists rows_deleted integer not null default 0;
alter table public.ireports360_visits_sync_runs
  add column if not exists rows_skipped_invalid_date integer not null default 0;
alter table public.ireports360_visits_sync_runs
  add column if not exists rows_skipped_reconcile integer not null default 0;

comment on column public.ireports360_visits_sync_runs.rows_deleted is
  'Rows removed from ireports360_visits by this run''s delete-reconciliation: present in the mirror for this run''s [date_from, date_to] window but absent from the fresh CRM fetch, so voided/deleted upstream.';
comment on column public.ireports360_visits_sync_runs.rows_skipped_invalid_date is
  'Visits this run fetched but did not upsert because the CRM returned a missing/invalid visitDate.';
comment on column public.ireports360_visits_sync_runs.rows_skipped_reconcile is
  'Stale rows this run found but did NOT delete because they exceeded the 50% sanity cap on the window''s existing rows — signals the fetch may have been partial/truncated rather than reflecting real CRM deletions. Investigate rather than assume these are safe to delete.';
