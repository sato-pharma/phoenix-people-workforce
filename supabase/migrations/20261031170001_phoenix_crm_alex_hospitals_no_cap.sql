-- Phoenix CRM — four named hospitals in Saad Salama's district (CNS, Alex-BHR) with no cap at all: any count on
-- the plan, and planned or unplanned visits logged there without a daily or weekly limit.
--
-- WHAT
--   1. phoenix_crm_offplan_exemptions.lifts_venue_cap: a row carrying it also lifts the venue's own daily number
--      (shared_place_daily_cap, 3 today) at the venue it names — for PLANNED visits as well as out-of-plan ones,
--      at the door AND on the plan's save and send. False (the default) keeps the 2026-10-17 behaviour exactly:
--      the venue number is lifted for an out-of-plan visit only. The Air Force hospital's row is not touched.
--   2. phoenix_crm_venue_cap_lifted(seat): the shared places of one seat under such a row — the one rule the
--      door (below) and the plan (server/plans.ts → sharedPlanCapRefusal) both ask.
--   3. phoenix_crm_shared_place_day_cap(): returns before it counts for a visit in a lifted venue.
--   4. Five rows, each customer AND venue name key, lifts_venue_cap = true:
--        Ahmed Ashraf Mahmoud Elsayed (SEAT-CNS-REP-AB3, Alex Center 1-West): مستشفى ايليت, مستشفي زمزم, مستشفي الروماني
--        Hager Noureldeen Ahmed Abdelmaged (SEAT-CNS-REP-AB1, Alex East): مستشفي مرقص ماري — and a second, key-only
--        row for the other spelling (مرقس), so a venue she captures under either spelling is covered.
--      The out-of-plan cap (2 a day, 8 a week) is lifted there by the existing door: phoenix_crm_offplan_exempt()
--      already matches a row's customer or venue key, and the trigger stamps such a visit and counts nothing.
--
-- WHY (owner, 2026-10-31, after the Air Force hospital exception was read back to him: "DO THE SAME FOR THE
--   MENTIONED HOSPITALS MAKE THEM NORMALLY ADD IN THEIR PLANS ANY COUNT IN THIS HOSPITALS AND MAKE THEM LOG VISITS
--   PLANNED/UNPLANNED IN THOSE HOSPITALS WITHOUT CAP")
--   Only the CAPS are lifted. The approval chain is untouched (an unplanned visit still needs its written reason and
--   still goes to the district manager, then SFE); the settings are untouched; no other seat is reached (every row
--   and every venue match is per seat); one visit per customer per day and the plan's AM/PM day caps (5 and 15)
--   stay; an account nobody has validated yet is still held at two visits.
--
-- ROLLBACK
--   update public.phoenix_crm_offplan_exemptions set ended_at = now()
--    where lifts_venue_cap and ended_at is null;                                        -- the soft way
--   (the hard way: restore phoenix_crm_shared_place_day_cap() from 20261017150000, then
--    drop function public.phoenix_crm_venue_cap_lifted(text);
--    delete from public.phoenix_crm_offplan_exemptions where lifts_venue_cap;
--    alter table public.phoenix_crm_offplan_exemptions drop column lifts_venue_cap;)
--   Nothing existing is rewritten or deleted by this migration, so there is no pre-image to take.

begin;
set local lock_timeout = '5s';

alter table public.phoenix_crm_offplan_exemptions
  add column if not exists lifts_venue_cap boolean not null default false;

comment on column public.phoenix_crm_offplan_exemptions.lifts_venue_cap is
  'Owner, 2026-10-31: the row also lifts the venue''s own daily number (shared_place_daily_cap) at the venue it names, for planned visits too, at the door and on the plan. False keeps the 2026-10-17 rule: lifted for an out-of-plan visit only.';

create or replace function public.phoenix_crm_venue_cap_lifted(p_seat text)
returns table (shared_place_id uuid)
language sql
stable
security definer
set search_path to 'public'
as $$
  select distinct sp.id
  from public.phoenix_crm_offplan_exemptions e
  join public.phoenix_crm_shared_places sp on sp.seat_id = e.seat_id
  where e.seat_id = p_seat
    and e.ended_at is null
    and e.lifts_venue_cap
    and e.venue_name_key is not null
    and public.phoenix_crm_fold_name(sp.name) like '%' || e.venue_name_key || '%';
$$;

revoke execute on function public.phoenix_crm_venue_cap_lifted(text) from public, anon, authenticated;
grant execute on function public.phoenix_crm_venue_cap_lifted(text) to service_role;

create or replace function public.phoenix_crm_shared_place_day_cap()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_shared uuid;
  v_cap integer;
  v_placed integer;
begin
  if new.place_id is null then
    return new;
  end if;
  select pl.shared_place_id into v_shared from public.phoenix_crm_places pl where pl.id = new.place_id;
  if v_shared is null then
    return new;
  end if;

  -- An out-of-plan visit under a named exception is not held to the venue's daily number.
  if new.unplanned_kind = 'out_of_plan'
     and public.phoenix_crm_offplan_exempt(new.seat_id, new.customer_id, new.place_id) then
    return new;
  end if;

  -- A venue the owner lifted outright (2026-10-31): no daily number there, planned or not.
  if exists (select 1 from public.phoenix_crm_venue_cap_lifted(new.seat_id) l where l.shared_place_id = v_shared) then
    return new;
  end if;

  select s.shared_place_daily_cap into v_cap from public.phoenix_crm_settings s where s.id = 1;
  v_cap := coalesce(v_cap, 3);

  select count(*) into v_placed
  from public.phoenix_crm_visits v
  join public.phoenix_crm_places pl on pl.id = v.place_id
  where pl.shared_place_id = v_shared
    and v.visit_date = new.visit_date
    and v.is_test = new.is_test
    and not v.offplan_exempt;

  if v_placed >= v_cap then
    raise exception 'phoenix_crm:shared_place_day_full';
  end if;
  return new;
end;
$$;

revoke execute on function public.phoenix_crm_shared_place_day_cap() from public, anon, authenticated;
grant execute on function public.phoenix_crm_shared_place_day_cap() to service_role;

-- The four hospitals. Each row names the hospital account on that seat's own list (joined on the seat, so a
-- customer that has since moved is skipped rather than reached on another seat) and the venue name key that
-- covers the doctors seated inside it.
insert into public.phoenix_crm_offplan_exemptions
  (seat_id, label, customer_id, venue_name_key, note, granted_by_hr_id, lifts_venue_cap)
select v.seat_id,
       v.label,
       c.id,
       public.phoenix_crm_fold_name(v.name_key),
       'Owner, 2026-10-31: any count on the plan; planned and unplanned visits at this hospital have no daily or weekly limit; approval stays DM then SFE.',
       'B-10',
       true
from (values
  ('SEAT-CNS-REP-AB3', 'مستشفى ايليت', '935e5636-13a1-4a8e-a672-100df061e516'::uuid, 'ايليت'),
  ('SEAT-CNS-REP-AB3', 'مستشفي زمزم', 'f38d5689-a61e-435b-9d0f-731be41b9b42'::uuid, 'زمزم'),
  ('SEAT-CNS-REP-AB3', 'مستشفي الروماني', '9330d29a-982a-4b03-aaf2-be894fcba8f5'::uuid, 'الروماني'),
  ('SEAT-CNS-REP-AB1', 'مستشفي مرقص ماري', '1277057a-2e45-4ba5-8fc3-6052a5bc432c'::uuid, 'مرقص')
) as v(seat_id, label, customer_id, name_key)
join public.phoenix_crm_customers c on c.id = v.customer_id and c.seat_id = v.seat_id
where not exists (
  select 1 from public.phoenix_crm_offplan_exemptions e
  where e.seat_id = v.seat_id and e.customer_id = c.id and e.ended_at is null
);

-- Mary Morcos Hospital spelled the other way (مرقس), for a venue Hager captures under that spelling.
insert into public.phoenix_crm_offplan_exemptions
  (seat_id, label, customer_id, venue_name_key, note, granted_by_hr_id, lifts_venue_cap)
select 'SEAT-CNS-REP-AB1',
       'مستشفي مرقص ماري',
       null,
       public.phoenix_crm_fold_name('مرقس'),
       'Owner, 2026-10-31: the second spelling of Mary Morcos Hospital; same exception as its account row.',
       'B-10',
       true
where not exists (
  select 1 from public.phoenix_crm_offplan_exemptions e
  where e.seat_id = 'SEAT-CNS-REP-AB1' and e.customer_id is null
    and e.venue_name_key = public.phoenix_crm_fold_name('مرقس') and e.ended_at is null
);

-- Every hospital account still on its seat has its row, plus the second spelling: five on production. A
-- customer that moved off its seat would leave a hospital uncovered in silence, so production stops the
-- migration instead. (Staging, cloned before these accounts existed, holds none of them and gets the one
-- key-only row.)
do $$
declare
  v_rows integer;
  v_accounts integer;
begin
  select count(*) into v_rows
  from public.phoenix_crm_offplan_exemptions e
  where e.seat_id in ('SEAT-CNS-REP-AB3', 'SEAT-CNS-REP-AB1')
    and e.lifts_venue_cap
    and e.ended_at is null;
  select count(*) into v_accounts
  from public.phoenix_crm_customers c
  where c.id in ('935e5636-13a1-4a8e-a672-100df061e516', 'f38d5689-a61e-435b-9d0f-731be41b9b42',
                 '9330d29a-982a-4b03-aaf2-be894fcba8f5', '1277057a-2e45-4ba5-8fc3-6052a5bc432c');
  if v_rows <> v_accounts + 1 or (v_accounts > 0 and v_accounts <> 4) then
    raise exception 'phoenix_crm_alex_hospitals_no_cap: % of 4 hospital accounts found, % active rows', v_accounts, v_rows;
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
