-- Production Supabase Advisor Center follow-up, part 2 (2026-07-19): the two
-- no_primary_key groups that were deferred in 20260719210000 pending verification.
-- Both are purely additive (ADD CONSTRAINT / no data touched, no rows changed) and
-- do not affect the rollback-safety-net purpose of the _au_rollback tables.

begin;

-- au.line_area_map: verified 125 rows, zero duplicates on (line_code, area_code,
-- effective_from) before applying. This is the natural temporal key for the SCD
-- table (effective_from/effective_to already model history; the existing partial
-- unique index only covers the "current" row). Present on every environment.
alter table au.line_area_map add primary key (line_code, area_code, effective_from);

-- _au_rollback.* — 10 untracked rollback-snapshot tables for the area-unification
-- Phase-9 cutover (see memory: au-rollback-tables-pending-teardown.md), created
-- directly against PRODUCTION outside the migration pipeline — confirmed the
-- schema does not exist on staging or (necessarily) any future fresh bootstrap.
-- Guarded with to_regclass so this migration stays a safe no-op anywhere the
-- schema is absent, and only acts where it's actually present. Verified every
-- table's natural key column has zero nulls and zero duplicates on production
-- before writing this. Adding a PK does not drop, alter, or read any row
-- differently — the tables remain exactly as usable for a rollback as before.
do $$
begin
  if to_regclass('_au_rollback.areas_full') is not null then
    alter table _au_rollback.areas_full add primary key (id);
  end if;
  if to_regclass('_au_rollback.coaching_reports_area') is not null then
    alter table _au_rollback.coaching_reports_area add primary key (id);
  end if;
  if to_regclass('_au_rollback.employee_history_area') is not null then
    alter table _au_rollback.employee_history_area add primary key (id);
  end if;
  if to_regclass('_au_rollback.job_offers_area') is not null then
    alter table _au_rollback.job_offers_area add primary key (id);
  end if;
  if to_regclass('_au_rollback.marketing_customers_area') is not null then
    alter table _au_rollback.marketing_customers_area add primary key (id);
  end if;
  if to_regclass('_au_rollback.marketing_pharmacies_area') is not null then
    alter table _au_rollback.marketing_pharmacies_area add primary key (id);
  end if;
  if to_regclass('_au_rollback.marketing_requests_area') is not null then
    alter table _au_rollback.marketing_requests_area add primary key (id);
  end if;
  if to_regclass('_au_rollback.position_vacancies_area') is not null then
    alter table _au_rollback.position_vacancies_area add primary key (id);
  end if;
  if to_regclass('_au_rollback.positions_area') is not null then
    alter table _au_rollback.positions_area add primary key (id);
  end if;
  if to_regclass('_au_rollback.employees_area') is not null then
    alter table _au_rollback.employees_area add primary key (hr_id);
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
