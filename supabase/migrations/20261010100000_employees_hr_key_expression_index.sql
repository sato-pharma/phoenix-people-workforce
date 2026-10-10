-- Two thirds of Phoenix's entire database time was spent rebuilding a 39-row roster.
--
-- `phoenix_crm_started_team_reps()` resolves each seat occupant's CRM id with a LATERAL that
-- matches `upper(btrim(e.hr_id))` against `employees`. No index could serve that expression, so
-- every rep cost a full 56-page scan of the table: ~39 reps = ~2,190 buffer hits = ~45 ms per
-- call of the function. `crm_visits_unified` calls it TWICE (it has two NOT EXISTS clauses) and
-- `crm_plan_entries_unified` calls it THREE times, so a single-day CRM read spent ~95 ms of its
-- ~100 ms rebuilding that roster and 0.36 ms reading the visits it was asked for.
--
-- Measured on production, 2026-10-10, before and after this index:
--   crm_visits_unified, one day          99.9 ms / 5,185 buffers  ->  38.4 ms / 1,028 buffers
--   crm_plan_entries_unified, one day     ~288 ms (live mean)     ->  23.2 ms / 1,272 buffers
--   phoenix_crm_started_team_reps() alone  45 ms / 2,190 buffers  ->   ~2.5 ms / 89 buffers warm
-- The three crm_*_unified views were 66.3% of all database time, on 2.1% of the calls; every
-- other statement in Phoenix averaged 1.8 ms. The index took 22,269 scans in its first minutes.
--
-- The matching expression is `upper(btrim(hr_id))` exactly as the function writes it — an index on
-- a different spelling (plain `hr_id`, or `lower(...)`) cannot be used for this lookup at all.
create index if not exists employees_hr_id_upper_trim_idx
  on public.employees (upper(btrim(hr_id)));

-- A `lower(btrim(hr_id))` twin was created alongside it on production while measuring and took
-- ZERO scans: the roster function's own `lower(...)` output is a hash-join key, never an index
-- probe. Dropped here so the schema carries only the index that is actually used.
drop index if exists public.employees_hr_id_lower_trim_idx;

analyze public.employees;
