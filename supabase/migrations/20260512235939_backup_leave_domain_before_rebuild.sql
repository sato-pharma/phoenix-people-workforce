-- Phoenix Workforce staging backup for the old leave/vacation domain.
-- Run before supabase/20260512_leave_management_engine.sql.
-- This script is intentionally non-destructive: it creates timestamped copies
-- of existing leave/vacation tables in the backup schema and skips missing tables.

begin;

create schema if not exists backup;
revoke all on schema backup from public, anon, authenticated;
grant usage on schema backup to service_role;

create table if not exists backup.leave_domain_backup_manifest (
  id bigserial primary key,
  source_schema text not null default 'public',
  source_table text not null,
  backup_schema text not null default 'backup',
  backup_table text null,
  row_count bigint null,
  status text not null,
  detail text null,
  backed_up_at timestamptz not null default now()
);

do $$
declare
  v_backup_schema text := 'backup';
  v_backup_table text;
  v_row_count bigint;
  v_stamp text := to_char(clock_timestamp(), 'YYYYMMDD_HH24MISS_MS');
  v_table text;
  v_tables text[] := array[
    'vacation_attachments',
    'vacation_approvals',
    'vacation_balances',
    'vacation_requests',
    'vacation_settings',
    'vacation_types',
    'leave_approvals',
    'leave_transactions',
    'leave_requests',
    'employee_leave_balances',
    'public_holidays',
    'leave_policies',
    'leave_types'
  ];
begin
  foreach v_table in array v_tables
  loop
    if to_regclass(format('public.%I', v_table)) is null then
      insert into backup.leave_domain_backup_manifest (
        source_table,
        status,
        detail
      )
      values (
        v_table,
        'skipped',
        'Source table does not exist.'
      );

      raise notice 'Skipping %. Source table does not exist.', v_table;
    else
      v_backup_table := format('lm_bak_%s_%s', v_table, v_stamp);

      execute format(
        'create table %I.%I (like public.%I including all)',
        v_backup_schema,
        v_backup_table,
        v_table
      );

      execute format(
        'insert into %I.%I select * from public.%I',
        v_backup_schema,
        v_backup_table,
        v_table
      );

      execute format(
        'select count(*) from %I.%I',
        v_backup_schema,
        v_backup_table
      )
      into v_row_count;

      insert into backup.leave_domain_backup_manifest (
        source_table,
        backup_table,
        row_count,
        status,
        detail
      )
      values (
        v_table,
        v_backup_table,
        v_row_count,
        'backed_up',
        format('Copied public.%s to backup.%s.', v_table, v_backup_table)
      );

      raise notice 'Backed up public.% to backup.% (% rows).', v_table, v_backup_table, v_row_count;
    end if;
  end loop;
end $$;

commit;
