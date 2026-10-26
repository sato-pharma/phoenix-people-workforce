-- Phoenix CRM — a dated exception to the out-of-plan cap for one rep: no daily or weekly limit, for a set
-- run of days, and the ordinary limit again on the day after it ends, with no job and no hand.
--
-- WHAT
--   1. phoenix_crm_offplan_exemptions gains rep_hr_id, valid_from and valid_until. A row carrying a rep and
--      both dates covers EVERY out-of-plan visit that rep logs on that seat between the two days, both
--      inclusive — no customer, no venue. Such a row must carry both dates and no customer or venue
--      (two CHECKs), so a rep-wide row can never be open-ended.
--   2. phoenix_crm_offplan_rep_exempt(seat, rep, day) answers whether a visit falls under one.
--   3. phoenix_crm_offplan_visit_cap() stamps such a visit offplan_exempt and returns before it counts, exactly
--      as it does for a named venue (20261017150000). The stamp keeps her first-month visits out of every
--      later count, so the ordinary 2 a day and 8 a week start clean on the first day after the window —
--      including in a field week the window ends inside. The admin entry skip (20261024223000) is unchanged.
--   4. The first row: Aya Mamdouh sdeek Ali (Pedia, Giza 4), hired 2026-10-24 — 2026-10-24 to 2026-11-23.
--
-- WHY (owner, 2026-10-26: "AYA MAMDOUH IS A NEW HIRE MAKE HER ABLE TO SUBMIT UNPLANNED VISITS DURING HER FIRST
--   HIRING MONTH UNPLANNED WITH NO CAP ONLY DURING THE FIRST MONTH THEN AUTOMATIC RETURN NORMAL")
--   A new rep has no sent plan to work from yet, so nearly every visit of her first month is out of plan.
--   Only the CAP is lifted: every such visit is still out_of_plan, still needs its written reason, and still
--   goes to her district manager and then the SFE. The settings (2 and 8) are not touched; no other rep is
--   reached (the row names her seat AND her). The venue's own daily number (phoenix_crm_shared_place_day_cap)
--   is not lifted for her — that is a limit on the place, not on the rep.
--
-- ROLLBACK
--   update public.phoenix_crm_offplan_exemptions set ended_at = now() where rep_hr_id = 'PD-0029';   -- the soft way
--   (the hard way: restore phoenix_crm_offplan_visit_cap() from 20261024223000, then
--    drop function public.phoenix_crm_offplan_rep_exempt(text, text, date);
--    delete from public.phoenix_crm_offplan_exemptions where rep_hr_id is not null;
--    alter table public.phoenix_crm_offplan_exemptions drop constraint phoenix_crm_offplan_exemptions_rep_window,
--      drop constraint phoenix_crm_offplan_exemptions_has_target, drop column rep_hr_id, drop column valid_from,
--      drop column valid_until, add constraint phoenix_crm_offplan_exemptions_has_target
--      check (customer_id is not null or venue_name_key is not null);)
--   Nothing existing is rewritten or deleted by this migration, so there is no pre-image to take.

begin;
set local lock_timeout = '5s';

alter table public.phoenix_crm_offplan_exemptions
  add column if not exists rep_hr_id text,
  add column if not exists valid_from date,
  add column if not exists valid_until date;

comment on column public.phoenix_crm_offplan_exemptions.rep_hr_id is
  'A rep-wide exception: every out-of-plan visit this rep logs on seat_id between valid_from and valid_until (both inclusive) is not capped. Such a row names no customer and no venue.';

alter table public.phoenix_crm_offplan_exemptions
  drop constraint if exists phoenix_crm_offplan_exemptions_has_target;
alter table public.phoenix_crm_offplan_exemptions
  add constraint phoenix_crm_offplan_exemptions_has_target
  check (customer_id is not null or venue_name_key is not null or rep_hr_id is not null);

-- A rep-wide row is always bounded and never also a venue row. Written with explicit IS NOT NULL so a NULL
-- comparison can never let an open-ended row through.
alter table public.phoenix_crm_offplan_exemptions
  drop constraint if exists phoenix_crm_offplan_exemptions_rep_window;
alter table public.phoenix_crm_offplan_exemptions
  add constraint phoenix_crm_offplan_exemptions_rep_window
  check (
    rep_hr_id is null
    or (
      valid_from is not null
      and valid_until is not null
      and valid_from <= valid_until
      and customer_id is null
      and venue_name_key is null
    )
  );

create or replace function public.phoenix_crm_offplan_rep_exempt(p_seat text, p_rep text, p_day date)
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
      and e.rep_hr_id = p_rep
      and e.ended_at is null
      and p_day between e.valid_from and e.valid_until
  );
$$;

revoke execute on function public.phoenix_crm_offplan_rep_exempt(text, text, date) from public, anon, authenticated;
grant execute on function public.phoenix_crm_offplan_rep_exempt(text, text, date) to service_role;

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
  -- The Super Admin recording what already happened: there is no other day to plan it for.
  if new.capture_source = 'admin' then
    return new;
  end if;

  -- A visit under a named exception — a venue of this seat, or this rep's dated window — is not capped and
  -- is stamped, so no count below includes it.
  if public.phoenix_crm_offplan_exempt(new.seat_id, new.customer_id, new.place_id)
     or public.phoenix_crm_offplan_rep_exempt(new.seat_id, new.rep_hr_id, new.visit_date) then
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

revoke execute on function public.phoenix_crm_offplan_visit_cap() from public, anon, authenticated;
grant execute on function public.phoenix_crm_offplan_visit_cap() to service_role;

-- The first rep-wide row: Aya Mamdouh sdeek Ali (Pedia, Giza 4), her first month from her hire date.
insert into public.phoenix_crm_offplan_exemptions (seat_id, rep_hr_id, valid_from, valid_until, label, note, granted_by_hr_id)
select 'SEAT-PED-REP-GZ4',
       'PD-0029',
       date '2026-10-24',
       date '2026-11-23',
       'New hire — first month',
       'Owner, 2026-10-26: a new hire, no daily or weekly limit on out-of-plan visits during her first month (hired 2026-10-24); the ordinary limit returns on 2026-11-24 by itself. Approval stays DM then SFE.',
       'B-10'
where not exists (
  select 1 from public.phoenix_crm_offplan_exemptions e
  where e.seat_id = 'SEAT-PED-REP-GZ4' and e.rep_hr_id = 'PD-0029' and e.ended_at is null
);

notify pgrst, 'reload schema';

commit;
