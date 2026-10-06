-- Phoenix CRM — the SFE Manager moves a customer from one rep's list to another's.
--
-- WHAT. Owner, 2026-10-06: "make the sfe able to enter on any med rep list and delete or drop from it
-- any irrelevant customer or move this customer to and choose where." Dropping needed no database
-- change — the SFE files a `drop` request at his own step and decides it in the same breath, exactly as
-- `sfeBringBack` already does for the Archive. MOVING a customer to another rep seat did not exist at
-- all, and this migration is that half:
--
--   phoenix_crm_customer_moves     one row per move: the customer, the seat he left, the seat he joined,
--                                  both lines, the written reason, who moved him and when. Append-only;
--                                  a customer may move more than once, and may move back.
--   phoenix_crm_move_customer()    moves one customer and his clinics to another seat in one
--                                  transaction, under an advisory lock on BOTH seats. Service role only.
--
-- WHY A MOVE IS NOT A DROP-AND-ADD. A place is validated once and is fixed forever (owner, 2026-09-29),
-- and `phoenix_crm_places` is keyed on the customer, not on the rep. Dropping the customer on one seat
-- and re-adding him on the other would make the new rep capture the photo and the GPS of a clinic
-- Phoenix already holds the fixed point for — a second place for one doorway, which is precisely what
-- the duplicates board exists to catch. So the customer row travels: same id, same grade, same
-- potential, same validation, same clinics, a new seat and that seat's line. Every visit already logged
-- stays exactly where it is, on the seat that did the work.
--
-- AND WHY THE PLAN REPORT HAD TO CHANGE IN THE SAME MIGRATION. `phoenix_crm_report_plan_vs_actual`
-- joins a plan item to the customer by id and never asks whose list he is on today, so a day the
-- customer's FORMER rep had already planned would have counted as a miss for ever — the rep is refused
-- the very visit the report blames him for not making. That is the same defect `20261002221947` fixed
-- for a DROPPED customer (`status <> 'dropped' or plan_date <= the Cairo drop day`), in the one other
-- shape it can take. The report now also asks, for each planned day, which seat held the customer at
-- the end of that Cairo day: the newest move at or before it decides, so a customer who moves away and
-- later moves back is counted on each seat exactly for the days he was there. With no move row the
-- answer is unchanged, which is every customer in the system today.
--
-- WHAT IT DOES NOT TOUCH. No visit, plan, KPI, payroll or pay table. No existing row changes: the table
-- is new and empty, and the report is byte-identical to 20261002221947's except the `held_by` lateral
-- and the one predicate that reads it. `phoenix_crm_customers` gains no column.
--
-- ROLLBACK. Safe while no customer has been moved (`select count(*) from
-- public.phoenix_crm_customer_moves` must be 0 — a move cannot be undone by dropping this, it can only
-- be reversed by moving the customer back):
--   begin;
--   drop function if exists public.phoenix_crm_move_customer(jsonb);
--   drop table if exists public.phoenix_crm_customer_moves;
--   -- then re-apply the report body from 20261002221947_phoenix_crm_plan_vs_actual_sent_days.sql
--   notify pgrst, 'reload schema';
--   commit;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. Nothing here
-- is destructive, bulk or irreversible: one empty table, one new function, and one read-only reporting
-- function replaced.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------------
-- 1. The record of every move
-- ---------------------------------------------------------------------------------------------------

create table if not exists public.phoenix_crm_customer_moves (
  id bigint generated always as identity primary key,
  customer_id uuid not null references public.phoenix_crm_customers (id) on delete restrict,
  from_seat_id text not null,
  to_seat_id text not null,
  from_line_code text not null,
  to_line_code text not null,
  reason text not null,
  moved_by_hr_id text not null,
  is_test boolean not null default false,
  moved_at timestamptz not null default now(),
  constraint phoenix_crm_customer_moves_seats check (btrim(from_seat_id) <> '' and btrim(to_seat_id) <> '' and from_seat_id <> to_seat_id),
  constraint phoenix_crm_customer_moves_reason check (char_length(btrim(reason)) between 10 and 500)
);

comment on table public.phoenix_crm_customer_moves is
  'Append-only: every time a Phoenix CRM customer was moved from one rep seat to another, with the written reason and who moved him. Written only by phoenix_crm_move_customer().';

create index if not exists phoenix_crm_customer_moves_customer_idx
  on public.phoenix_crm_customer_moves (customer_id, moved_at desc);

create index if not exists phoenix_crm_customer_moves_from_seat_idx
  on public.phoenix_crm_customer_moves (from_seat_id, moved_at desc);

-- Locked exactly as every other table in this module is: RLS on, one service-role policy, and nothing
-- for the keys that ship in the browser bundle.
alter table public.phoenix_crm_customer_moves enable row level security;
create policy phoenix_crm_customer_moves_service_role
  on public.phoenix_crm_customer_moves for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_customer_moves from public, anon, authenticated;
grant all on table public.phoenix_crm_customer_moves to service_role;

-- ---------------------------------------------------------------------------------------------------
-- 2. The move
-- ---------------------------------------------------------------------------------------------------

create or replace function public.phoenix_crm_move_customer(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_customer_id uuid := nullif(p ->> 'customer_id', '')::uuid;
  v_from_seat text := nullif(trim(coalesce(p ->> 'from_seat_id', '')), '');
  v_to_seat text := nullif(trim(coalesce(p ->> 'to_seat_id', '')), '');
  v_to_line text := nullif(trim(coalesce(p ->> 'to_line_code', '')), '');
  v_reason text := nullif(regexp_replace(trim(coalesce(p ->> 'reason', '')), '\s+', ' ', 'g'), '');
  v_customer public.phoenix_crm_customers%rowtype;
  v_from_line text;
  v_places integer := 0;
  v_move_id bigint;
begin
  if v_actor is null or v_customer_id is null or v_from_seat is null or v_to_seat is null or v_to_line is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_from_seat = v_to_seat then
    raise exception 'phoenix_crm:same_seat';
  end if;
  if v_reason is null or char_length(v_reason) < 10 or char_length(v_reason) > 500 then
    raise exception 'phoenix_crm:note_required';
  end if;

  -- Both seats, in a fixed order, so two moves in opposite directions cannot deadlock.
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || least(v_from_seat, v_to_seat)));
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || greatest(v_from_seat, v_to_seat)));

  select c.* into v_customer
  from public.phoenix_crm_customers c
  where c.id = v_customer_id
    and c.seat_id = v_from_seat
    and c.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:customer_not_found';
  end if;
  if v_customer.status = 'dropped' then
    raise exception 'phoenix_crm:customer_dropped';
  end if;
  -- A customer met outside the list is on nobody's list, so there is nothing to hand over: he is
  -- admitted or archived where he stands (phoenix_crm_archive_outside).
  if v_customer.status = 'outside' then
    raise exception 'phoenix_crm:not_on_list';
  end if;
  v_from_line := v_customer.line_code;

  -- ONE CUSTOMER, ONE NAME KEY on the seat he joins — the same fold the sheet loader and the rename
  -- apply, so a move can never create the duplicate the duplicates board exists to raise. An archived
  -- namesake on the destination is not a clash: he is off the list.
  if exists (
    select 1
    from public.phoenix_crm_customers c
    where c.seat_id = v_to_seat
      and c.is_test = v_is_test
      and c.status <> 'dropped'
      and c.list_type = v_customer.list_type
      and public.phoenix_crm_fold_name(c.name) = public.phoenix_crm_fold_name(v_customer.name)
  ) then
    raise exception 'phoenix_crm:duplicate_at_destination';
  end if;
  -- And the destination cannot already carry his iReports360 row (phoenix_crm_customers_reference_uidx).
  if v_customer.reference_contact_crm_id is not null and exists (
    select 1
    from public.phoenix_crm_customers c
    where c.seat_id = v_to_seat
      and c.is_test = v_is_test
      and c.reference_contact_crm_id = v_customer.reference_contact_crm_id
  ) then
    raise exception 'phoenix_crm:duplicate_at_destination';
  end if;

  update public.phoenix_crm_customers c
  set seat_id = v_to_seat,
      line_code = v_to_line,
      updated_at = now()
  where c.id = v_customer.id
  returning c.* into v_customer;

  -- The clinics travel with him: the fixed point, the photo and the hours are the customer's, not the
  -- rep's, and a validated place is never captured twice.
  update public.phoenix_crm_places pl
  set seat_id = v_to_seat,
      updated_at = now()
  where pl.customer_id = v_customer.id;
  get diagnostics v_places = row_count;

  -- Anything still waiting belonged to the seat he left and its reviewers. It is withdrawn rather than
  -- carried over: the new rep did not ask for it, and the old rep's manager no longer decides for him.
  with withdrawn as (
    update public.phoenix_crm_list_requests q
    set status = 'withdrawn',
        stage = null,
        decided_at = now(),
        decided_by_hr_id = v_actor,
        decision_note = 'The customer moved to another rep'
    where q.customer_id = v_customer.id
      and q.status = 'pending'
    returning q.id
  )
  insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
  select v_from_seat, v_customer.id, w.id, 'request_withdrawn', v_actor, jsonb_build_object('why', 'moved'), v_is_test
  from withdrawn w;

  insert into public.phoenix_crm_customer_moves (
    customer_id, from_seat_id, to_seat_id, from_line_code, to_line_code, reason, moved_by_hr_id, is_test
  )
  values (v_customer.id, v_from_seat, v_to_seat, v_from_line, v_to_line, v_reason, v_actor, v_is_test)
  returning id into v_move_id;

  -- Two events, one on each seat's trail: the list he left reads that he went, and the list he joined
  -- reads where he came from. One row on one seat would leave the other list with no history at all.
  insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
  values
    (v_from_seat, v_customer.id, 'customer_moved_out', v_actor,
     jsonb_build_object('to_seat_id', v_to_seat, 'to_line_code', v_to_line, 'reason', v_reason, 'places', v_places), v_is_test),
    (v_to_seat, v_customer.id, 'customer_moved_in', v_actor,
     jsonb_build_object('from_seat_id', v_from_seat, 'from_line_code', v_from_line, 'reason', v_reason, 'places', v_places), v_is_test);

  return jsonb_build_object(
    'move_id', v_move_id,
    'customer_id', v_customer.id,
    'customer_name', v_customer.name,
    'list_type', v_customer.list_type,
    'status', v_customer.status,
    'from_seat_id', v_from_seat,
    'to_seat_id', v_to_seat,
    'places', v_places
  );
end;
$$;

comment on function public.phoenix_crm_move_customer(jsonb) is
  'Moves one Phoenix CRM customer and his clinics from one rep seat to another, in one transaction, with the written reason recorded in phoenix_crm_customer_moves. Refuses a duplicate at the destination. The SFE Manager''s own act — the app is the authority on who may call it.';

revoke execute on function public.phoenix_crm_move_customer(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_move_customer(jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------------
-- 3. The plan report counts a customer only for the days he was on that seat
-- ---------------------------------------------------------------------------------------------------
-- Byte-identical to 20261002221947_phoenix_crm_plan_report_sent_and_dropped.sql except for the
-- `held_by` lateral in `planned` and the one predicate that reads it.

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
    -- 🔴 WHICH SEAT HELD HIM AT THE END OF THAT CAIRO DAY. The newest move at or before the day
    -- decides, so a customer who moved away and later moved back is counted on each seat exactly for
    -- the days he was there — a `max(moved_at)` would have excluded the days after his return. No move
    -- row at all means he never left, which is every customer until one is moved.
    left join lateral (
      select m.to_seat_id
      from public.phoenix_crm_customer_moves m
      where m.customer_id = i.customer_id
        and (m.moved_at at time zone 'Africa/Cairo')::date <= i.plan_date
      order by m.moved_at desc, m.id desc
      limit 1
    ) held_by on true
    -- 🔴 AND NEITHER IS A CUSTOMER WHO HAS LEFT THE LIST. phoenix_crm_save_visit raises
    -- `phoenix_crm:customer_dropped` for him, so a day planned after the drop is a visit the rep is
    -- REFUSED and was then counted as having missed. The day of the drop itself stays in — he was on
    -- the list for part of it — and the Cairo day is read from the instant, because
    -- `status_changed_at::date` would be the UTC one and would move every drop made in the first two
    -- or three hours of a Cairo day into the day before.
    where (
      c.status <> 'dropped'
      or i.plan_date <= ((c.status_changed_at at time zone 'Africa/Cairo')::date)
    )
      -- A day after he was handed to another rep is the same refusal in the other shape: this rep
      -- cannot visit him, so the day is out of HIS denominator and sits in the new rep's.
      and (held_by.to_seat_id is null or held_by.to_seat_id = pl.seat_id)
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

comment on function public.phoenix_crm_report_plan_vs_actual(text[], date, date, boolean) is
  'Plan versus actual per seat, day and list: a day counts only when it stood on a sent plan, a customer counts only while he is validated, on the list and on THAT seat, and an off-plan visit is shown beside the miss rather than inside it.';

revoke execute on function public.phoenix_crm_report_plan_vs_actual(text[], date, date, boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_report_plan_vs_actual(text[], date, date, boolean) to service_role;

notify pgrst, 'reload schema';

commit;
