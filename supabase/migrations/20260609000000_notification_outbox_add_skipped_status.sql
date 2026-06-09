-- Widen notification_outbox.status to add a terminal 'skipped' state.
--
-- Deterministic non-sends (disabled policy, unsupported type, missing global config, no
-- recipients resolved) were previously routed through the FAILURE path: they burned all
-- 5 retry attempts and then landed in the terminalFailed metric, polluting alerting and
-- masking genuine delivery failures. They now go to a terminal 'skipped' state instead.
--
-- The original CHECK was created inline with the table (constraint name
-- notification_outbox_status_check). Verify the live constraint name before applying:
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'public.notification_outbox'::regclass and contype = 'c';
-- If 'skipped' rows already exist (they cannot, pre-migration), normalise them first.

-- NOTE: notification_outbox is created as a minimal stub (id, created_at) by
-- 20260509030000_legacy_access_tables_branch_baseline.sql; its full shape incl. the
-- `status` column comes from the loose root file phoenix-notification-outbox-phase-3.sql,
-- which a migrations-only rebuild (e.g. the Supabase branch preview) does NOT replay.
-- So guard on the column's existence: apply the CHECK only where `status` exists; no-op
-- (cleanly) on a stub-only rebuild. Idempotent — safe to re-run; prod is unaffected
-- (already applied via the migration history).

begin;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'notification_outbox'
      and column_name = 'status'
  ) then
    alter table public.notification_outbox
      drop constraint if exists notification_outbox_status_check;

    alter table public.notification_outbox
      add constraint notification_outbox_status_check
        check (status in ('pending', 'processing', 'sent', 'failed', 'skipped'));

    -- Supports the retention sweep that purges aged terminal skipped rows.
    create index if not exists notification_outbox_skipped_updated_idx
      on public.notification_outbox (updated_at)
      where status = 'skipped';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
