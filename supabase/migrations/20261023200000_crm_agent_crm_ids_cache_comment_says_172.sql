-- crm_agent_crm_ids_cache: the comment said 254 rows. It holds 172.
--
-- WHAT THIS CHANGES: two COMMENTs. No table, function, grant, policy or row is touched.
--
-- WHY:
--   20261023190000 was written against a count taken before the cache existed:
--     select count(*) from (select distinct agent_hr_id, agent_crm_id
--                             from public.crm_visits_unified
--                            where agent_crm_id is not null) x   -> 254
--   That count does not filter the KEY. Read back on production on 2026-10-23 right after the
--   migration was applied:
--     distinct pairs, no key filter   255
--     of those, agent_hr_id is null    83
--     rows actually in the cache      172
--   The 83 NULL-keyed pairs can never be returned by the door - `where c.agent_hr_id =
--   any(p_agent_hr_ids)` is never true for NULL - and the pre-cache body had exactly the same
--   blind spot, so nothing changed hands: `crm_agent_crm_ids_calc()` drops them explicitly and
--   the answer is identical. Only the stated size was wrong, and it was wrong by 48%.
--
--   Proof the answer is identical: the live-shaped input (the 108 non-active employees) returned
--   76 distinct crm ids before the cache and returns the same 76 after - 220 ms / 57,005 shared
--   buffers before, 2.3 ms / 406 after, of which 198 buffers belong to the employees lookup that
--   builds the input array.
--
-- The owner's instruction is quoted as he said it ("Cache the 254 pairings") wherever it appears;
-- it is the figures stated as fact that are corrected here and in docs/crm-agent-crm-ids-cache.md.

begin;
set local lock_timeout = '5s';

comment on table public.crm_agent_crm_ids_cache is
  'Distinct (agent_hr_id, agent_crm_id) pairs from crm_visits_unified with a non-null key - 172 rows on 2026-10-23 (255 pairs exist; 83 carry a NULL agent_hr_id that no caller can match, and crm_agent_crm_ids_calc() drops them). Read by phx_crm_agent_crm_ids_for_hr_ids. Rebuilt through crm_agent_crm_ids_calc() by the 15-minute crm-agent-crm-ids-reconcile job; no trigger is possible, the view has ~10 inputs.';

comment on function public.crm_agent_crm_ids_calc(text) is
  'The one body behind crm_agent_crm_ids_cache: distinct (agent_hr_id, agent_crm_id) pairs in crm_visits_unified, NULL keys excluded (they are unmatchable by every caller). Expensive by nature (~136k rows scanned, 220 ms); callers read the cache, not this.';

commit;
