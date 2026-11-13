-- ci_employee_keys — the nightly schema check can see every key that ties a row to a real employee
--
-- WHAT THIS CHANGES:
--   Adds public.phx_ci_employee_keys(): one row per foreign key from a table column to
--   public.employees(hr_id) — the table, the column, the constraint name, and whether Postgres has
--   validated it. Read-only. service_role only. Read by scripts/check-schema-shape.ts, which compares
--   it with the committed baseline scripts/employee-key-baseline.json every night on staging and
--   production (Migration Drift Check).
--
-- WHY (enterprise audit 2026-11-13, F-DB-001, REC-037: "the orphan count is zero and stays zero"):
--   20261113160008, 20261113160747 and 20261113161558 put the key on every money, leave and
--   attendance table, each after an orphan count of zero. A validated key makes an orphan row
--   impossible, so "stays zero" means "the key stays, and stays validated". The repository test that
--   pins those migrations cannot see a key dropped or left NOT VALID by hand, through execute_sql,
--   which is how most of this schema has actually changed. This function lets the nightly check ask
--   the live database, and the baseline is a count that may only rise.
--
-- MEASURED 2026-11-13 (read-only), before this was written:
--   production 112 keys, all validated, on 78 tables; staging the same 112 (identical fingerprint).
--
-- ROLLBACK:
--   drop function if exists public.phx_ci_employee_keys();
--   Nothing else is created, and no row is read or changed outside the system catalogue.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration changes no application data.

begin;
set local lock_timeout = '5s';

create or replace function public.phx_ci_employee_keys()
returns table (
  table_schema text,
  table_name text,
  column_name text,
  constraint_name text,
  validated boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    n.nspname::text,
    r.relname::text,
    a.attname::text,
    c.conname::text,
    c.convalidated
  from pg_constraint c
  join pg_class r on r.oid = c.conrelid
  join pg_namespace n on n.oid = r.relnamespace
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
  join pg_attribute fa on fa.attrelid = c.confrelid and fa.attnum = c.confkey[1]
  where c.contype = 'f'
    and c.confrelid = 'public.employees'::regclass
    and array_length(c.confkey, 1) = 1
    and fa.attname = 'hr_id'
  order by n.nspname, r.relname, a.attname;
$$;

revoke execute on function public.phx_ci_employee_keys() from public, anon, authenticated;
grant execute on function public.phx_ci_employee_keys() to service_role;

commit;
