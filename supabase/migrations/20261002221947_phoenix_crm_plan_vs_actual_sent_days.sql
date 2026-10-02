-- phoenix_crm_plan_vs_actual_sent_days
--
-- WHAT THIS CHANGES:
--   phoenix_crm_report_plan_vs_actual — its LIVE body (20260926163000_phoenix_crm_unplanned_visits.sql,
--   identical to production: md5(pg_get_functiondef) b558afb9baeb77b39b8008d4a5ea3df3, md5(prosrc)
--   a640ac7a7b6fe55d2f46de171c9295b3, measured 2026-10-02) with TWO changes and nothing else. Every
--   other line is that text byte for byte; no table, column, view, grant or policy changes.
--
--   1. `sent_days` — it asked whether the plan's latest status as of the end of that Cairo day was in
--      ('submitted', 'approved', 'RETURNED'). That third value is the defect: a RETURNED week is one
--      the rep has back and may edit, so `phoenix_crm_save_visit` does NOT treat it as authority and
--      stamps a visit on it `is_unplanned` — while this report counted its customers as PLANNED and,
--      where they were not seen, as MISSED. The two halves of the same question answered differently:
--      the rep's visit reads "off the plan, waiting for your manager" on his own screen, and his
--      manager's plan-against-actual reads "missed" about the very same customer on the very same day.
--
--      It now applies the SAME test the save applies (`v_on_sent_plan`, migration 20261002125244) and
--      the same one every screen applies (plan-rules.ts `isPlanDaySent` → `planDayStatus`):
--        * the latest status by the end of that Cairo day is 'submitted' or 'approved'; or
--        * that latest event is a ONE-DAY return — to 'returned', carrying `returned_day` in its
--          details — of a DIFFERENT day, which no acknowledged edit request has since opened. A week
--          returned for one day is still authority on every OTHER day (owner, 2026-10-02, "Still
--          planned"); a week returned WHOLE carries no day and is authority on none of them, which is
--          exactly what the old third value got wrong.
--
--      🔴 So the header of 20261002125244 was wrong where it said replacing this function "would
--      change nothing". It is right about the one-day return — those days did already read as sent —
--      and wrong about the whole-week return and about the returned day itself, which read as sent
--      here and as unsent at the door.
--
--   2. `planned` — it kept a customer DROPPED mid-week on every day of the week, so his planned days
--      AFTER the drop counted as MISSED. They cannot be anything else: `phoenix_crm_save_visit` raises
--      `phoenix_crm:customer_dropped` for him, so the rep is refused the visit the report then blames
--      him for not making. A dropped customer's items dated AFTER the Cairo day he left the list are
--      now out of the denominator; the day of the drop itself stays in (he was on the list for part of
--      it), and a customer brought back is 'active' again and counts throughout.
--
-- WHAT DOES NOT CHANGE:
--   `visited` keeps the base table rather than the countable view, deliberately — this report's job is
--   to SHOW a manager the off-plan work, and a visit that has vanished from it cannot be approved by
--   anyone. The two `validated_at is not null` joins stay on both sides. Nothing about the aggregate
--   columns, the full join, the ordering or the signature moves.
--
-- WHY: the 2026-10-02 Phoenix CRM audit. Both defects produce a MISS — the one figure on this report a
--   manager acts on — against a rep who did nothing wrong, and both are silent: the number is a
--   plausible integer either way.
--
-- ROLLBACK: re-apply the function body from supabase/migrations/20260926163000_phoenix_crm_unplanned_visits.sql
--   (the `create or replace function public.phoenix_crm_report_plan_vs_actual` block, verbatim). It is a
--   STABLE reporting function that writes nothing, so a rollback restores the old figures immediately
--   and loses no data. Nothing here is destructive, bulk, or irreversible.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This one is neither: it replaces one read-only reporting function and touches no row.

begin;
set local lock_timeout = '5s';

create or replace function public.phoenix_crm_report_plan_vs_actual(
  p_seat_ids text[],
  p_from date,
  p_to date,
  p_include_test boolean default false
)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with plan_days as (
    select distinct pl.id as plan_id, i.plan_date
    from public.phoenix_crm_plans pl
    join public.phoenix_crm_plan_items i on i.plan_id = pl.id
    where pl.seat_id = any (p_seat_ids)
      and pl.week_start between p_from - 6 and p_to
      and i.plan_date between p_from and p_to
      and (p_include_test or not pl.is_test)
  ),
  -- WAS THIS DAY ON A SENT PLAN? The plan's latest event by the end of that Cairo day — the same
  -- "before the next Cairo midnight" boundary as before, and the same test phoenix_crm_save_visit
  -- applies at the door (v_on_sent_plan) and plan-rules.ts applies on every screen (isPlanDaySent).
  --
  -- A draft is the rep's own to edit, so it is never authority; a week returned WHOLE is back with
  -- him too, so it is not authority either — which is what the old `in (..., 'returned')` got wrong.
  -- The one exception is a ONE-DAY return (owner, 2026-10-02, "Still planned"): that week still
  -- stands on every OTHER day exactly as it stood when the day was returned, until an acknowledged
  -- edit request opens the whole week to him, because a day he can change is never authority.
  --
  -- `cross join lateral … limit 1` rather than a scalar subquery because the branch needs THREE
  -- fields of that one latest event — its status, its details and its own time — and asking for them
  -- in three subqueries would let the three read different events on a tie.
  sent_days as (
    select d.plan_id, d.plan_date
    from plan_days d
    cross join lateral (
      select e.to_status, e.details, e.created_at
      from public.phoenix_crm_plan_events e
      where e.plan_id = d.plan_id
        and e.to_status is not null
        and e.created_at < ((d.plan_date + 1)::timestamp at time zone 'Africa/Cairo')
      order by e.created_at desc, e.id desc
      limit 1
    ) latest
    where latest.to_status in ('submitted', 'approved')
       or (
         latest.to_status = 'returned'
         and nullif(latest.details ->> 'returned_day', '') is not null
         and nullif(latest.details ->> 'returned_day', '')::date <> d.plan_date
         and not exists (
           select 1
           from public.phoenix_crm_plan_edit_requests r
           where r.plan_id = d.plan_id
             and r.hr_acknowledged_at > latest.created_at
             and r.hr_acknowledged_at < ((d.plan_date + 1)::timestamp at time zone 'Africa/Cairo')
         )
       )
  ),
  planned as (
    select pl.seat_id, pl.is_test, i.plan_date, i.customer_id, i.list_type
    from sent_days s
    join public.phoenix_crm_plans pl on pl.id = s.plan_id
    join public.phoenix_crm_plan_items i on i.plan_id = s.plan_id and i.plan_date = s.plan_date
    -- The DENOMINATOR: planning a customer who is not validated yet is never held against the rep.
    join public.phoenix_crm_customers c on c.id = i.customer_id and c.validated_at is not null
    -- 🔴 AND NEITHER IS A CUSTOMER WHO HAS LEFT THE LIST. phoenix_crm_save_visit raises
    -- `phoenix_crm:customer_dropped` for him, so a day planned after the drop is a visit the rep is
    -- REFUSED and was then counted as having missed. The day of the drop itself stays in — he was on
    -- the list for part of it — and the Cairo day is read from the instant, because
    -- `status_changed_at::date` would be the UTC one and would move every drop made in the first two
    -- or three hours of a Cairo day into the day before.
    where c.status <> 'dropped'
       or i.plan_date <= ((c.status_changed_at at time zone 'Africa/Cairo')::date)
  ),
  -- The base table on purpose, not the countable view: this report's job is to SHOW the manager the
  -- off-plan work, and a visit that has vanished from it cannot be approved by anyone. What the
  -- decision changes is the two columns beside it.
  visited as (
    select v.seat_id, v.is_test, v.visit_date, v.customer_id, v.list_type, v.is_unplanned, u.status as unplanned_status
    from public.phoenix_crm_visits v
    -- The NUMERATOR: the same filter, so both sides move together.
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    left join public.phoenix_crm_unplanned_visits u on u.visit_id = v.id
    where v.seat_id = any (p_seat_ids)
      and v.visit_date between p_from and p_to
      and (p_include_test or not v.is_test)
  ),
  joined as (
    select
      coalesce(pd.seat_id, vd.seat_id) as seat_id,
      coalesce(pd.plan_date, vd.visit_date) as day,
      coalesce(pd.list_type, vd.list_type) as list_type,
      pd.customer_id is not null as is_planned,
      vd.customer_id is not null as is_visited,
      coalesce(vd.is_unplanned, false) as is_unplanned,
      vd.unplanned_status
    from planned pd
    full join visited vd
      on vd.seat_id = pd.seat_id
     and vd.is_test = pd.is_test
     and vd.visit_date = pd.plan_date
     and vd.customer_id = pd.customer_id
  )
  select coalesce(jsonb_agg(to_jsonb(t) order by t.seat_id, t.day, t.list_type), '[]'::jsonb)
  from (
    select
      j.seat_id,
      j.day,
      j.list_type,
      (count(*) filter (where j.is_planned))::integer as planned,
      -- A visit the rep did not plan is not a plan he kept, however the plan was edited afterwards.
      (count(*) filter (where j.is_planned and j.is_visited and not j.is_unplanned))::integer as visited_planned,
      -- Beside it, never silently a miss: he was there, and it is waiting on somebody.
      (count(*) filter (where j.is_planned and j.is_visited and j.is_unplanned and j.unplanned_status in ('manager_pending', 'sfe_pending')))::integer as planned_waiting,
      (count(*) filter (where j.is_planned and not j.is_visited))::integer as missed,
      (count(*) filter (where j.is_visited and not j.is_planned))::integer as unplanned,
      (count(*) filter (where j.is_visited and not j.is_planned and j.unplanned_status in ('manager_pending', 'sfe_pending')))::integer as unplanned_waiting,
      (count(*) filter (where j.is_visited and not j.is_planned and j.unplanned_status = 'refused'))::integer as unplanned_refused
    from joined j
    group by j.seat_id, j.day, j.list_type
  ) t;
$$;

-- check:migrations refuses a file whose SECURITY DEFINER functions carry no revoke from PUBLIC.
-- `create or replace` keeps the existing ACL, so these restate it rather than changing it.
revoke execute on function public.phoenix_crm_report_plan_vs_actual(text[], date, date, boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_report_plan_vs_actual(text[], date, date, boolean) to service_role;

notify pgrst, 'reload schema';

commit;
