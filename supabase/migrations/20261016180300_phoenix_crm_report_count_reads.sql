-- phoenix_crm_report_count_reads
--
-- WHAT THIS CHANGES: two new READ functions, no schema change and no data change. Each one returns a
-- COUNT the app used to make itself by carrying every row across the wire and adding them up.
--
--   1. phoenix_crm_plan_item_counts(p_plan_ids uuid[])
--      "How many customers does each of these plans hold?" — one row per plan that holds any.
--
--      WHY: the exceptions board (src/lib/phoenix-crm/server/exceptions.ts, `loadPlanFacts`) read
--      every item of this field week's plans — about seventy a plan, so some ten thousand rows for a
--      whole company — in keyset pages of 1,000, one page after the other, only to count them per
--      plan. The SFE Manager and the Super Admin, who open the board most, waited for every page.
--      The count is the same count: every item row of the asked plans, no other condition, exactly
--      what the loop added up. A plan with no item has no row and reads 0, as an empty tally did.
--      Served by the `phoenix_crm_plan_items_one_a_day` unique index, which leads with plan_id.
--
--   2. phoenix_crm_seat_visit_firsts(p_seat_ids text[], p_is_test boolean)
--      "When was each of these territories' first countable visit, and how many have there been?"
--
--      WHY: the adoption report (src/lib/phoenix-crm/server/adoption.ts, `loadVisitFirsts`) read the
--      WHOLE visit history of every territory in scope — "ever" is the question, so there is no date
--      floor — row by row, a thousand a page in series, to produce two numbers per territory; it
--      grows by some six hundred rows every working day. The same view, the same two filters (the
--      seat, the world) and nothing else: `min(visit_date)` skips a missing date as the loop did,
--      and `count(*)` counts every row, dated or not, as the loop did.
--
--      🔴 NO `customer_validated` FILTER, DELIBERATELY — the adoption board asks whether a territory
--      has STARTED, and a rep logging a visit to a carried-over doctor nobody has validated yet has
--      plainly started (the reason is written out at `loadVisitFirsts`). It reads
--      `phoenix_crm_countable_visits`, never the base table: a visit still waiting for its approval
--      has not adopted anything.
--
-- No figure on any screen changes: each function returns the number the app computed from the same
-- rows. Both are STABLE (they read, never write), SECURITY DEFINER with a pinned search_path like every
-- function in the module, and executable by the service role alone. Each returns one row per plan or
-- territory asked about, and the callers ask in batches of 500 plans and 150 territories, so no answer
-- approaches PostgREST's 1,000-row cap.
--
-- 🔴 APPLY BEFORE THE CODE THAT CALLS THEM IS DEPLOYED. The exceptions board and the adoption report
-- call these by name; until they exist both boards fail with "function not found" rather than showing
-- anything wrong.
--
-- ROLLBACK:
--   drop function public.phoenix_crm_seat_visit_firsts(text[], boolean);
--   drop function public.phoenix_crm_plan_item_counts(uuid[]);
--   and revert the two callers with them — nothing else to undo: no table, column, grant or row is
--   touched.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. This
-- migration writes nothing.

begin;
set local lock_timeout = '5s';

-- ── 1. Items per plan ────────────────────────────────────────────────────────────────────────────

create or replace function public.phoenix_crm_plan_item_counts(p_plan_ids uuid[])
returns table (plan_id uuid, items integer)
language sql
stable
security definer
set search_path to 'public'
as $$
  select i.plan_id, count(*)::integer as items
  from public.phoenix_crm_plan_items i
  where i.plan_id = any(p_plan_ids)
  group by i.plan_id;
$$;

revoke execute on function public.phoenix_crm_plan_item_counts(uuid[]) from public, anon, authenticated;
grant execute on function public.phoenix_crm_plan_item_counts(uuid[]) to service_role;

-- ── 2. Each territory's first countable visit, and how many ──────────────────────────────────────

create or replace function public.phoenix_crm_seat_visit_firsts(p_seat_ids text[], p_is_test boolean)
returns table (seat_id text, first_visit_on date, visits_ever integer)
language sql
stable
security definer
set search_path to 'public'
as $$
  select v.seat_id, min(v.visit_date) as first_visit_on, count(*)::integer as visits_ever
  from public.phoenix_crm_countable_visits v
  where v.seat_id = any(p_seat_ids)
    and v.is_test = p_is_test
  group by v.seat_id;
$$;

revoke execute on function public.phoenix_crm_seat_visit_firsts(text[], boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_seat_visit_firsts(text[], boolean) to service_role;

notify pgrst, 'reload schema';

commit;
