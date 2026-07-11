-- Performance: add indexes on employees(full_name) and employees(employment_status).
-- full_name: covers the ORDER BY full_name queries (~96k calls in pg_stat_statements).
-- employment_status: covers the .not("employment_status", "in", ...) filters added to
-- attendance device-user-mapping and policies callers.

create index if not exists idx_employees_full_name
  on public.employees (full_name);

create index if not exists idx_employees_employment_status
  on public.employees (employment_status);
