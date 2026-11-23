-- The items of many plans in ONE statement, for the Team tab's two plan-review reads:
-- phoenix_crm_plan_review_items(p_plan_ids uuid[]).
--
-- WHY (owner, 23 Nov 2026: "fix the slow Field CRM board"). The admin board opens on Team, and the Team tab
-- asks for the week's plan reviews and the month's plan reviews beside the Team read. For the Super Admin
-- (111 territories) those two waited 2.8-3.1 s each on production (measured 23 Nov 2026 in the browser on
-- phoenix-hr.satopharma.com), and the board was whole only at about 5.5 s. Most of it was the plan items:
-- loadPlanItemRows (src/lib/phoenix-crm/server/plans.ts) reads them 50 plans at a time, four groups in
-- flight, and each group of ~3,200 rows comes back 1,000 rows a page, ONE PAGE AFTER ANOTHER — and every
-- page joins and sorts the whole group again (EXPLAIN ANALYZE on production: 54 ms a page, 18,450 buffers).
-- The week's reviews made 7 item requests in 4 waves, the month's 19 in 6, each wave paying the edge's
-- per-request cost (20261102040000's account: ~450 ms for a few ms of SQL). This answers them in one.
--
-- WHAT IT RETURNS. One jsonb array, never a set, because PostgREST's row cap applies to a set-returning
-- function too (docs/postgrest-row-ceiling.md; phoenix_crm_territory_customers is the precedent): every
-- item of p_plan_ids in the shape PostgREST gives REVIEW_ITEM_COLUMNS —
--   {id, plan_id, plan_date, customer_id, list_type, receives,
--    customer: {status} or null, place: {lat, lon, status} or null}
-- in id order, which is the keyset walk's order inside each plan, so no day's points move.
--
-- NO FIGURE CHANGES: the same rows and the same columns the reads gave; the TypeScript is unchanged after
-- the read (pinned by tests/phoenix-crm-plan-review-items.test.ts). SECURITY DEFINER (search_path
-- 'public'), executable by the service role only, as the reads were. Until it is applied the callers fall
-- back to loadPlanItemRows (PGRST202), so the branch deploys before the database moves.
--
-- ROLLBACK:
--   drop function if exists public.phoenix_crm_plan_review_items(uuid[]);

begin;

set local lock_timeout = '5s';

create or replace function public.phoenix_crm_plan_review_items(p_plan_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', i.id,
        'plan_id', i.plan_id,
        'plan_date', i.plan_date,
        'customer_id', i.customer_id,
        'list_type', i.list_type,
        'receives', i.receives,
        'customer', case when c.id is null then null else jsonb_build_object('status', c.status) end,
        'place', case when p.id is null then null else jsonb_build_object('lat', p.lat, 'lon', p.lon, 'status', p.status) end
      )
      order by i.id
    ),
    '[]'::jsonb
  )
  from public.phoenix_crm_plan_items i
  left join public.phoenix_crm_customers c on c.id = i.customer_id
  left join public.phoenix_crm_places p on p.id = i.place_id
  where i.plan_id = any(p_plan_ids);
$$;

revoke execute on function public.phoenix_crm_plan_review_items(uuid[]) from public, anon, authenticated;
grant execute on function public.phoenix_crm_plan_review_items(uuid[]) to service_role;

notify pgrst, 'reload schema';

commit;
