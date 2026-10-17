-- Phoenix CRM — a named exception to the out-of-plan cap: one rep, one hospital, no daily or weekly limit.
--
-- WHAT
--   1. phoenix_crm_offplan_exemptions: one row per exception — a SEAT, and what is exempt for it: a customer
--      (the hospital account itself) and/or a venue name key (a shared place of that seat whose folded name
--      contains it, so the doctors seated in that hospital are covered too). `ended_at` ends it.
--   2. phoenix_crm_visits.offplan_exempt: stamped at the door on an out-of-plan visit that falls under an
--      exception. Every reader of "how many out-of-plan doctors has he visited" leaves the stamped ones out.
--   3. phoenix_crm_offplan_visit_cap() and phoenix_crm_shared_place_day_cap() skip an exempt out-of-plan
--      visit and stop counting stamped ones, so the exception never uses up the rep's 2 a day / 8 a week
--      anywhere else and never uses up a venue's 3 a day for the planned doctors there.
--   4. phoenix_crm_offplan_exempt() (the predicate) and phoenix_crm_offplan_exempt_customers() (the rep's
--      picker: which of his customers are exempt, and under which label).
--   5. The first exception: Mostafa Mahmoud Mohamed Ali's seat (CNS, Cairo, Nasr City) at مستشفي الجوي التخصصي.
--
-- WHY (owner, 2026-10-17: "when he goes to this hospital only he can submit unplanned visits without the rule
--   of two — five, six — but only in this hospital … the unplanned goes approval to his manager and the SFE,
--   the normal workflow", and, asked whether these visits should use up his normal numbers elsewhere:
--   "everything as it is today, the exception is only for الجوي التخصصي")
--   The approval chain is untouched: an exempt visit is still `out_of_plan`, still starts at the district
--   manager and then SFE, and still needs its written reason. Only the CAP is lifted, and only here.
--
-- ROLLBACK
--   update public.phoenix_crm_offplan_exemptions set ended_at = now() where ended_at is null;   -- the soft way
--   (the hard way: restore the two function bodies from 20261010214440 and 20261010013001, then
--    drop function public.phoenix_crm_offplan_exempt_customers(text);
--    drop function public.phoenix_crm_offplan_exempt(text, uuid, uuid);
--    alter table public.phoenix_crm_visits drop column offplan_exempt;
--    drop table public.phoenix_crm_offplan_exemptions;)
--   Nothing existing is rewritten or deleted by this migration, so there is no pre-image to take.

begin;

create table if not exists public.phoenix_crm_offplan_exemptions (
  id uuid primary key default gen_random_uuid(),
  seat_id text not null,
  label text not null,
  customer_id uuid,
  venue_name_key text,
  note text,
  granted_by_hr_id text,
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  constraint phoenix_crm_offplan_exemptions_has_target check (customer_id is not null or venue_name_key is not null)
);

create index if not exists phoenix_crm_offplan_exemptions_seat_idx
  on public.phoenix_crm_offplan_exemptions (seat_id) where ended_at is null;

alter table public.phoenix_crm_offplan_exemptions enable row level security;
revoke all on table public.phoenix_crm_offplan_exemptions from public, anon, authenticated;
grant all on table public.phoenix_crm_offplan_exemptions to service_role;

comment on table public.phoenix_crm_offplan_exemptions is
  'Named exceptions to the out-of-plan cap (owner, 2026-10-17): a seat plus a customer and/or a venue name key. An out-of-plan visit under an active row is not counted by phoenix_crm_visits_offplan_cap or phoenix_crm_visits_shared_place_cap. The approval chain is untouched.';

alter table public.phoenix_crm_visits
  add column if not exists offplan_exempt boolean not null default false;

comment on column public.phoenix_crm_visits.offplan_exempt is
  'Stamped by phoenix_crm_visits_offplan_cap: the out-of-plan visit fell under an active phoenix_crm_offplan_exemptions row, so no out-of-plan count includes it.';

create or replace function public.phoenix_crm_offplan_exempt(p_seat text, p_customer uuid, p_place uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from public.phoenix_crm_offplan_exemptions e
    where e.seat_id = p_seat
      and e.ended_at is null
      and (
        (e.customer_id is not null and e.customer_id = p_customer)
        or (
          e.venue_name_key is not null
          and p_place is not null
          and exists (
            select 1
            from public.phoenix_crm_places pl
            join public.phoenix_crm_shared_places sp on sp.id = pl.shared_place_id
            where pl.id = p_place
              and sp.seat_id = p_seat
              and public.phoenix_crm_fold_name(sp.name) like '%' || e.venue_name_key || '%'
          )
        )
      )
  );
$$;

revoke execute on function public.phoenix_crm_offplan_exempt(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.phoenix_crm_offplan_exempt(text, uuid, uuid) to service_role;

create or replace function public.phoenix_crm_offplan_exempt_customers(p_seat text)
returns table (customer_id uuid, label text)
language sql
stable
security definer
set search_path to 'public'
as $$
  select distinct c.id, e.label
  from public.phoenix_crm_offplan_exemptions e
  join public.phoenix_crm_customers c on c.seat_id = e.seat_id
  where e.seat_id = p_seat
    and e.ended_at is null
    and (
      (e.customer_id is not null and c.id = e.customer_id)
      or (
        e.venue_name_key is not null
        and exists (
          select 1
          from public.phoenix_crm_places pl
          join public.phoenix_crm_shared_places sp on sp.id = pl.shared_place_id
          where pl.customer_id = c.id
            and sp.seat_id = e.seat_id
            and public.phoenix_crm_fold_name(sp.name) like '%' || e.venue_name_key || '%'
        )
      )
    );
$$;

revoke execute on function public.phoenix_crm_offplan_exempt_customers(text) from public, anon, authenticated;
grant execute on function public.phoenix_crm_offplan_exempt_customers(text) to service_role;

create or replace function public.phoenix_crm_offplan_visit_cap()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_daily integer;
  v_weekly integer;
  v_week_start date;
  v_day_doctors integer;
  v_week_doctors integer;
begin
  -- A visit under a named exception is not capped and is stamped, so no count below includes it.
  if public.phoenix_crm_offplan_exempt(new.seat_id, new.customer_id, new.place_id) then
    new.offplan_exempt := true;
    return new;
  end if;

  select s.offplan_daily_cap, s.offplan_weekly_cap into v_daily, v_weekly
  from public.phoenix_crm_settings s where s.id = 1;
  v_daily := coalesce(v_daily, 2);
  v_weekly := coalesce(v_weekly, 8);

  v_week_start := new.visit_date - ((extract(dow from new.visit_date)::integer + 1) % 7);

  select count(distinct v.customer_id) into v_day_doctors
  from public.phoenix_crm_visits v
  where v.seat_id = new.seat_id
    and v.is_test = new.is_test
    and v.unplanned_kind = 'out_of_plan'
    and v.list_type in ('AM', 'PM')
    and not v.offplan_exempt
    and v.visit_date = new.visit_date
    and v.customer_id <> new.customer_id;
  if v_day_doctors >= v_daily then
    raise exception 'phoenix_crm:offplan_day_full';
  end if;

  select count(distinct v.customer_id) into v_week_doctors
  from public.phoenix_crm_visits v
  where v.seat_id = new.seat_id
    and v.is_test = new.is_test
    and v.unplanned_kind = 'out_of_plan'
    and v.list_type in ('AM', 'PM')
    and not v.offplan_exempt
    and v.visit_date >= v_week_start
    and v.visit_date < v_week_start + 7
    and v.customer_id <> new.customer_id;
  if v_week_doctors >= v_weekly then
    raise exception 'phoenix_crm:offplan_week_full';
  end if;

  return new;
end;
$$;

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

-- The first exception: Mostafa Mahmoud Mohamed Ali's seat, at the Air Force Specialised Hospital.
insert into public.phoenix_crm_offplan_exemptions (seat_id, label, customer_id, venue_name_key, note, granted_by_hr_id)
select 'SEAT-CNS-REP-CA2',
       'مستشفي الجوي التخصصي',
       c.id,
       public.phoenix_crm_fold_name('الجوي'),
       'Owner, 2026-10-17: unplanned visits at this hospital are not limited to 2 a day or 8 a week; approval stays DM then SFE.',
       'B-10'
from public.phoenix_crm_customers c
where c.id = '01850dd5-8346-40fc-86ab-211825063ee6'
  and c.seat_id = 'SEAT-CNS-REP-CA2'
  and not exists (
    select 1 from public.phoenix_crm_offplan_exemptions e
    where e.seat_id = 'SEAT-CNS-REP-CA2' and e.customer_id = c.id and e.ended_at is null
  );

notify pgrst, 'reload schema';

commit;
