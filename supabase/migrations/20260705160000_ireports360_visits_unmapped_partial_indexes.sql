-- getUnmappedCrmIdentities() paginates ireports360_visits with keyset pagination
-- (id > cursor) filtered by agent_hr_id IS NULL (agent loop) and
-- double_crm_id IS NOT NULL AND double_hr_id IS NULL (double loop).
--
-- Without partial indexes Postgres must do a full sequential scan of the entire
-- table (~93k rows with a wide raw_payload jsonb column) for every page fetch,
-- which exceeds the 8-second statement timeout and causes the
-- "canceling statement due to statement timeout" error on GET /admin/visits-report.
--
-- These two partial indexes let Postgres resolve each paginated fetch by touching
-- only the unmapped rows (≈8% of the table for agents, much fewer for doubles),
-- bringing per-page query time from ~7-8s down to milliseconds.

create index if not exists ireports360_visits_unmapped_agent_id_idx
  on public.ireports360_visits (id)
  where agent_hr_id is null;

create index if not exists ireports360_visits_unmapped_double_id_idx
  on public.ireports360_visits (id)
  where double_crm_id is not null and double_hr_id is null;