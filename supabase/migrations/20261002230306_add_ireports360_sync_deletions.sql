-- WHAT   Adds public.ireports360_sync_deletions: one row per mirror visit or check-in id that the
--        iReports360 reconciliation deletes, written by src/lib/crm/sync.ts immediately BEFORE each
--        delete chunk. Nothing existing is altered and nothing is deleted.
--
-- WHY    The nightly parity sweep deleted 1,879 mirror visit rows over five consecutive nights
--        (Mar-Jun windows: 366, 351, 353, 458, +1) and recorded only COUNTS. src/lib/crm/parity.ts
--        writes counts to ireports360_parity_windows, src/lib/crm/sync.ts writes rows_deleted on the
--        sync-run row, and ireports360_parity_windows is a running state table rather than a log, so
--        the ids were unrecoverable the moment they were gone. Production has NO point-in-time
--        recovery: 7 daily backups are the whole recovery story. The sweep also reads a condition
--        the owner's locked CRM rule says does not occur -- "the CRM admin deactivates and CLONES,
--        never deletes" (.claude/rules/crm.md) -- so a one-sided "extra in mirror" result is at
--        least as likely to be a fetch artefact as a genuine vendor deletion. Recording the ids
--        makes a wrong delete reversible by id instead of by whole-database restore.
--
--        Written on the destructive path and read by nobody in the app, so it is service-role only:
--        no grants to anon/authenticated and no RLS policy, matching the other operational tables
--        in this module. A row here is evidence, never business data.
--
-- ROLLBACK
--        drop table if exists public.ireports360_sync_deletions;
--        Safe at any time: no other object references it and no application read depends on it.
--        Dropping it loses the archive of whatever has been deleted since this applied.

create table if not exists public.ireports360_sync_deletions (
  id uuid primary key default gen_random_uuid(),
  -- 'visit' | 'checkin' -- which reconciliation removed the row.
  kind text not null check (kind in ('visit', 'checkin')),
  -- crm_visit_id or crm_checkin_id as the vendor issued it. Not unique: the same id can legitimately
  -- be deleted, re-synced from a later vendor answer, and deleted again.
  record_id bigint not null,
  -- visit_date for a visit, the date part of check_date for a check-in. Nullable because the
  -- check-ins reconciliation reads ids only and must stay best-effort.
  record_date date,
  -- The mirror row's own synced_at, so a delete can be told from a concurrent insert after the fact.
  synced_at timestamptz,
  -- The window the reconciliation was scoped to, which is what makes a parity-sweep delete
  -- attributable to the logged {crm_parity_sweep_repaired} line for the same window.
  window_from date not null,
  window_to date not null,
  -- The sync run that performed it, joining to ireports360_visits_sync_runs.id.
  sync_run_id uuid,
  -- The sync's own trigger string ('cron', 'manual', ...), carried so a manual backfill's deletes
  -- are distinguishable from the nightly sweep's without a join.
  trigger text,
  deleted_at timestamptz not null default now()
);

comment on table public.ireports360_sync_deletions is
  'Every mirror visit/check-in id the iReports360 reconciliation deleted, written before the delete. Exists because production has no PITR and the parity sweep previously recorded only counts: 1,879 rows went in five nights with no id anywhere. Service-role only; evidence, not business data.';

create index if not exists ireports360_sync_deletions_deleted_at_idx
  on public.ireports360_sync_deletions (deleted_at desc);

create index if not exists ireports360_sync_deletions_record_idx
  on public.ireports360_sync_deletions (kind, record_id);

create index if not exists ireports360_sync_deletions_window_idx
  on public.ireports360_sync_deletions (window_from, window_to);

-- Service-role only. anon and authenticated inherit through PUBLIC, so PUBLIC is revoked first.
revoke all on public.ireports360_sync_deletions from public, anon, authenticated;
grant select, insert on public.ireports360_sync_deletions to service_role;

-- RLS on with no policy: the service-role client bypasses RLS, and anything else gets nothing.
-- This table is never read from a browser.
alter table public.ireports360_sync_deletions enable row level security;
