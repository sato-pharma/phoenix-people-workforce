-- Owner instruction: full revert of the area/region/line unification, with zero
-- exceptions -- including the Sales/Source-of-Sales region_code carve-out that had been
-- kept alive by 20260707180000_restore_region_code_for_sales_scope_only.sql. Drops
-- employees.region_code entirely; the corresponding code (access-scope.ts,
-- portal-sos-dashboard.ts, employee-directory.ts, employee-portal/service.ts) has already
-- been reverted back to plain regionName-based matching in this same delivery, and that
-- code no longer reads this column, so it's safe to drop.

begin;

drop index if exists public.employees_region_code_idx;
alter table public.employees drop column if exists region_code;

commit;
