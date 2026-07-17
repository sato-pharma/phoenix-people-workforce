-- getUnmappedCrmIdentities() paginates ireports360_visits with keyset pagination,
-- filtering agent_hr_id IS NULL (or double_hr_id IS NULL) and ordering by id.
-- Without a partial index the planner falls back to a full sequential scan on every
-- page fetch — agent_hr_id IS NULL is only ~8% selective, so each query scans ~92%
-- of the table and blows the 8-second Postgres statement timeout.
--
-- Partial indexes covering only the rows each loop cares about let the planner do a
-- pure index scan in id order, making every page fetch O(page_size) instead of O(table).

create index if not exists ireports360_visits_unmapped_agent_id_idx
  on public.ireports360_visits (id)
  where agent_hr_id is null;

create index if not exists ireports360_visits_unmapped_double_id_idx
  on public.ireports360_visits (id)
  where double_crm_id is not null and double_hr_id is null;