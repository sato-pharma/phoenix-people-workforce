-- ci_recovery_runs
--
-- WHAT THIS CHANGES:
--   1. Adds public.phx_ci_recovery_runs(): when the hourly recovery snapshotter last finished a run
--      without an error, and how many runs and failed runs the last 48 hours hold. Read by
--      scripts/check-schema-shape.ts, service_role only.
--   2. Moves four staging-only pre-image tables out of `public` into dated backup schemas, if they
--      exist: employees_area_label_preimage_20260929 and employees_team_label_preimage_20260929 to
--      employees_backup_20260929; zz_mask_preimage_20261006_names and
--      zz_mask_preimage_app_auth_users_20261006 to masking_backup_20261006. Production has none of
--      them (moved or never created), so there this half is a no-op.
--
-- WHY:
--   The nightly Migration Drift Check goes red on a finding again (2026-10-23), and two of its
--   findings were wrong for staging rather than real:
--   - `recovery_snapshot_stale` judged the dead-man's switch by the newest snapshot CONTENT. A
--     snapshot is written only when a protected table changes, and staging's money tables never
--     change, so staging read "178 hours old" while its scheduler ran every hour without an error
--     (48 runs in 48 hours, tables_changed 0, read live 2026-10-23). The run log is the direct
--     answer to "has the scheduler stopped?", so the check now reads it.
--   - `missing_primary_key` flagged four dated pre-image tables left in staging's `public`. A
--     snapshot belongs in a dated backup schema, never in `public` (the same rule
--     20261023023133_move_dated_backup_tables_out_of_public applied on production).
--
-- ROLLBACK:
--   drop function if exists public.phx_ci_recovery_runs();
--   alter table employees_backup_20260929.<table> set schema public;  (and likewise for the
--   masking_backup_20261006 tables). No row is changed or removed by either half.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration changes no application data.

begin;
set local lock_timeout = '5s';

create or replace function public.phx_ci_recovery_runs()
returns table (
  newest_ok_run_at timestamptz,
  runs_48h integer,
  failed_runs_48h integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    (select max(r.started_at) from recovery.snapshot_runs r where r.error is null) as newest_ok_run_at,
    (select count(*)::integer from recovery.snapshot_runs r where r.started_at > now() - interval '48 hours') as runs_48h,
    (select count(*)::integer from recovery.snapshot_runs r
      where r.started_at > now() - interval '48 hours' and r.error is not null) as failed_runs_48h;
$$;

revoke execute on function public.phx_ci_recovery_runs() from public, anon, authenticated;
grant execute on function public.phx_ci_recovery_runs() to service_role;

do $do$
declare
  v_move record;
begin
  for v_move in
    select * from (values
      ('employees_area_label_preimage_20260929', 'employees_backup_20260929'),
      ('employees_team_label_preimage_20260929', 'employees_backup_20260929'),
      ('zz_mask_preimage_20261006_names', 'masking_backup_20261006'),
      ('zz_mask_preimage_app_auth_users_20261006', 'masking_backup_20261006')
    ) as m(table_name, target_schema)
  loop
    if to_regclass(format('public.%I', v_move.table_name)) is not null then
      execute format('create schema if not exists %I', v_move.target_schema);
      execute format('revoke all on schema %I from public, anon, authenticated', v_move.target_schema);
      execute format('alter table public.%I set schema %I', v_move.table_name, v_move.target_schema);
      execute format('revoke all on table %I.%I from anon, authenticated', v_move.target_schema, v_move.table_name);
      raise notice 'moved public.% to %', v_move.table_name, v_move.target_schema;
    end if;
  end loop;
end
$do$;

commit;
