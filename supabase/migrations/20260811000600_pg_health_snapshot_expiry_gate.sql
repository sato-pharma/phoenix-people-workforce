-- Snapshot retention gate, from the 2026-08-10 production Postgres health audit.
--
-- docs/security/backup-table-placement.md already says the right thing -- "a sealed schema
-- is safe storage, not a reason to keep it forever" -- and `check:sql-backups` already stops
-- a snapshot being created in `public`. What nothing enforced was that a snapshot ever
-- LEAVES. By 2026-08-10 there were 15 dated schemas plus 11 dated tables inside `au`,
-- 101 tables and 1,122,814 rows totalling 183 MB, the oldest 13 days old and none ever
-- dropped. That is 10% of the database, and it would have grown back within six weeks.
--
-- The schema name carries its own expiry date, exactly as that doc intended, so the gate
-- reads the date out of the name. A deliberate long-lived scratch schema simply must not
-- be named with a trailing date.

create or replace function public.phx_ci_stale_snapshot_schemas(p_max_age_days integer default 30)
returns table (
  schema_name  text,
  taken_on     date,
  age_days     integer,
  tables_count bigint,
  size_bytes   bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with dated as (
    select n.nspname::text as schema_name,
           to_date(right(n.nspname, 8), 'YYYYMMDD') as taken_on
    from pg_namespace n
    where n.nspname ~ '[0-9]{8}$'
      and n.nspname not in ('public', 'au')
      and n.nspname !~ '^(pg_|information_schema)'
  )
  select d.schema_name,
         d.taken_on,
         -- Cairo, never UTC: production Postgres runs UTC, so an unzoned current_date reads
         -- as yesterday between Cairo 00:00 and 03:00 and would age every schema a day short.
         (((now() at time zone 'Africa/Cairo')::date) - d.taken_on)::integer as age_days,
         count(c.oid)                          as tables_count,
         coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint as size_bytes
  from dated d
  left join pg_class c
    on c.relnamespace = d.schema_name::regnamespace
   and c.relkind in ('r','p','m')
  where ((now() at time zone 'Africa/Cairo')::date) - d.taken_on > greatest(p_max_age_days, 1)
  group by d.schema_name, d.taken_on
  order by d.taken_on;
$$;

comment on function public.phx_ci_stale_snapshot_schemas(integer) is
  'Dated snapshot schemas older than the retention window. Consumed by scripts/check-schema-shape.ts so a snapshot cannot be left behind silently.';

revoke execute on function public.phx_ci_stale_snapshot_schemas(integer) from public, anon, authenticated;
grant execute on function public.phx_ci_stale_snapshot_schemas(integer) to service_role;
