-- Phoenix CRM — a visit the Super Admin ENTERS for a rep is not held to the rep's out-of-plan cap.
--
-- WHAT
--   phoenix_crm_offplan_visit_cap() returns at once for a visit whose capture_source is 'admin' — before it
--   counts the day's or the week's out-of-plan doctors. Every other visit, and the whole of the rest of the
--   function (the named exemptions, the daily and weekly numbers read from the settings, the field-week
--   arithmetic), is the body from 20261017150000 unchanged.
--
-- WHY (owner, 2026-10-24: "when admin is the one entering the visits for a rep do not show this — You have
--   reached the most customers you can visit out of your plan in one day. Plan this one for another day.")
--   The cap tells a rep to plan a visit for another day. An admin entering what already happened has no other
--   day to give: the visit took place on the day he is recording. The approval chain is untouched — an admin
--   visit that is out of plan still goes to the Administrator first, then the manager and SFE.
--   The visit is NOT stamped offplan_exempt, so it still counts toward that rep's own numbers for the day and
--   week when he later logs a visit himself, exactly as before.
--
-- ROLLBACK
--   Restore the function body from 20261017150000_phoenix_crm_offplan_exemptions.sql (CREATE OR REPLACE).
--   Nothing is rewritten or deleted by this migration, so there is no pre-image to take.

begin;
set local lock_timeout = '5s';

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

revoke execute on function public.phoenix_crm_offplan_visit_cap() from public, anon, authenticated;
grant execute on function public.phoenix_crm_offplan_visit_cap() to service_role;

notify pgrst, 'reload schema';

commit;
