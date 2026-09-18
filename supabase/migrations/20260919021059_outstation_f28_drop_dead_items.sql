-- outstation_f28_drop_dead_items
--
-- WHAT THIS CHANGES: the rest of audit finding F-28 (docs/outstation-expenses-audit.md), the unused
-- outstation items the owner asked to remove on 2026-09-19:
--   1. public.geo_trip_routes — the whole table. No code reads or writes it.
--   2. public.outstation_expenses.open_status — the expense ledger's "Open" column. It was blank
--      on every row and the Expense Report hid it by default. The owner chose "Remove it".
--   3. public.outstation_expense_requests.report_hr_status and report_hr_notes — a request-level HR
--      status and note that no screen let anyone fill in. The owner chose "Remove them". The expense
--      ledger's OWN hr_status / hr_notes (public.outstation_expenses) are a different pair and STAY.
--
-- The six other report_* columns (am/pm workload, trip type, travel cost, meeting, other) and
-- public.outstation_policy_rules are LIVE today and are NOT touched.
--
-- WHY: carrying cost only. Production on 2026-09-19: geo_trip_routes 0 rows; open_status,
-- report_hr_status and report_hr_notes non-blank on 0 rows each; no view, rule or function names
-- any of them.
--
-- ORDER: apply only AFTER the code that stopped reading and writing these columns is serving on
-- production. The code before that PR still inserts report_hr_* and open_status, so dropping first
-- would break outstation submits and expense imports.
--
-- PRE-IMAGE: any non-blank value and any geo_trip_routes row is copied into
-- outstation_backup_20260919.f28_dropped_values first, and the copy is counted against the source
-- before anything is dropped. On 2026-09-19 that copy holds 0 rows, because there is nothing to copy.
--
-- ROLLBACK (the data is in the pre-image; the shapes are below):
--   alter table public.outstation_expenses add column open_status text;
--   alter table public.outstation_expense_requests add column report_hr_status text, add column report_hr_notes text;
--   geo_trip_routes: re-run its DDL from supabase/migrations/20260711135352_phoenix_production_schema_baseline.sql,
--     which is the table (CREATE TABLE public.geo_trip_routes, identity geo_trip_routes_id_seq), geo_trip_routes_pkey,
--     geo_trip_routes_employee_idx, geo_trip_routes_month_status_idx, geo_trip_routes_employee_hr_id_fkey
--     (-> employees(hr_id) on update cascade on delete set null), row level security, the five policies
--     (_select_access, _service_role, _write_delete, _write_insert, _write_update) and the grants, then
--     20260717132337_phx_rls_setbased_visibility.sql's `alter policy geo_trip_routes_select_access`.
--   Reverting the pull request does NOT reverse this migration; only another migration does.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

-- ---------------------------------------------------------------------------
-- 1. Pre-image, in a dated schema of its own (never public: PostgREST does not expose it)
-- ---------------------------------------------------------------------------
create schema if not exists outstation_backup_20260919;
revoke all on schema outstation_backup_20260919 from public, anon, authenticated;

create table if not exists outstation_backup_20260919.f28_dropped_values (
  id            bigserial   primary key,
  source_table  text        not null,
  source_id     text        not null,
  column_name   text,
  row_data      jsonb       not null,
  backed_up_at  timestamptz not null default now()
);

comment on table outstation_backup_20260919.f28_dropped_values is
  'Every non-blank value of outstation_expenses.open_status and outstation_expense_requests.report_hr_status / report_hr_notes, and every geo_trip_routes row, copied before the 2026-09-19 F-28 migration dropped them (owner: "remove the rest of the F-28 dead outstation items").';

revoke all on table outstation_backup_20260919.f28_dropped_values from public, anon, authenticated;

insert into outstation_backup_20260919.f28_dropped_values (source_table, source_id, column_name, row_data)
select 'outstation_expenses', e.id::text, 'open_status', jsonb_build_object('open_status', e.open_status)
from public.outstation_expenses e
where nullif(btrim(e.open_status), '') is not null;

insert into outstation_backup_20260919.f28_dropped_values (source_table, source_id, column_name, row_data)
select 'outstation_expense_requests', r.id::text, 'report_hr_status', jsonb_build_object('report_hr_status', r.report_hr_status)
from public.outstation_expense_requests r
where nullif(btrim(r.report_hr_status), '') is not null;

insert into outstation_backup_20260919.f28_dropped_values (source_table, source_id, column_name, row_data)
select 'outstation_expense_requests', r.id::text, 'report_hr_notes', jsonb_build_object('report_hr_notes', r.report_hr_notes)
from public.outstation_expense_requests r
where nullif(btrim(r.report_hr_notes), '') is not null;

insert into outstation_backup_20260919.f28_dropped_values (source_table, source_id, column_name, row_data)
select 'geo_trip_routes', g.id::text, null, to_jsonb(g)
from public.geo_trip_routes g;

-- The copy must match the source exactly, or nothing is dropped.
do $$
declare
  source_count bigint;
  copied_count bigint;
begin
  select
      (select count(*) from public.outstation_expenses where nullif(btrim(open_status), '') is not null)
    + (select count(*) from public.outstation_expense_requests where nullif(btrim(report_hr_status), '') is not null)
    + (select count(*) from public.outstation_expense_requests where nullif(btrim(report_hr_notes), '') is not null)
    + (select count(*) from public.geo_trip_routes)
  into source_count;

  select count(*) into copied_count from outstation_backup_20260919.f28_dropped_values;

  if copied_count <> source_count then
    raise exception 'F-28 pre-image holds % row(s) but the source has % — nothing was dropped', copied_count, source_count;
  end if;

  raise notice 'F-28 pre-image: % row(s) copied', copied_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The drops
-- ---------------------------------------------------------------------------
-- SAFE: no code reads or writes geo_trip_routes; 0 rows on production 2026-09-19, and any row is in the pre-image above.
drop table if exists public.geo_trip_routes;

alter table public.outstation_expenses drop column if exists open_status;

alter table public.outstation_expense_requests
  drop column if exists report_hr_status,
  drop column if exists report_hr_notes;

commit;

-- Before you push, the rules that fail the required `validate` job:
--   * a public SECURITY DEFINER function must
--       revoke execute on function public.<fn>(<args>) from public, anon, authenticated;
--     and then re-grant what needs it (revoking PUBLIC also strips service_role).
--   * never  alter default privileges ... in schema public grant ... to anon|authenticated
--   * a snapshot table goes in <domain>_backup_YYYYMMDD, never in public
--   * DROP TABLE / TRUNCATE wants a  -- SAFE: <reason>  annotation
-- Timestamp 20260919021059 was minted to sort after every migration already on main.
