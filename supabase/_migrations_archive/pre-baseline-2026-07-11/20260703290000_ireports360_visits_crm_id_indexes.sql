-- ireports360_visits had no index on agent_crm_id/double_crm_id — any query filtering on
-- either (e.g. the "Map to HR ID" resolution flow's UPDATE ... WHERE agent_crm_id = :crmId)
-- forced a full sequential scan of the table. Measured at ~7.8s on the current row count
-- (93,696 rows with a wide raw_payload jsonb column per row), right at the edge of the 8s
-- Postgres statement timeout — intermittently failing depending on server load.

create index if not exists ireports360_visits_agent_crm_id_idx on public.ireports360_visits (agent_crm_id);
create index if not exists ireports360_visits_double_crm_id_idx on public.ireports360_visits (double_crm_id);
