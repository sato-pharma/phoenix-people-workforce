-- Phoenix CRM — a rep may visit at most 2 doctors a day and 8 doctors a week OUT OF PLAN.
--
-- WHAT
--   1. phoenix_crm_settings gains `offplan_daily_cap` (default 2) and `offplan_weekly_cap` (default 8),
--      beside pm_daily_cap, am_daily_cap and shared_place_daily_cap — SETTINGS, never constants, so the
--      Super Admin moves them on the Settings tab without a deploy.
--   2. A BEFORE INSERT trigger on phoenix_crm_visits refuses the visit that would take a rep over either
--      number, raising `phoenix_crm:offplan_day_full` / `phoenix_crm:offplan_week_full`.
--
-- WHY (owner, 2026-10-10: "maximum 2 drs a day are visited out of plan and maximum 8 drs in the full week")
--   What is counted is the OUT-OF-PLAN doctor visit: `unplanned_kind = 'out_of_plan'` on an AM or PM
--   customer, per SEAT, counting DISTINCT doctors (a second out-of-plan visit to a doctor already counted
--   that day or that week takes no new place, so it is never refused). Out-of-list visits (a customer who
--   is not on his list at all, validated on the spot) and pharmacy calls are NOT counted: neither is an
--   "out of plan" doctor, and a pharmacy has never been capped.
--   The week is the FIELD WEEK — Saturday to Thursday, a Friday belonging to the week before it — the
--   module's own week (calendar.ts `fieldWeekStart`).
--   It is a trigger for the reason the shared-place cap is: the rep's own save, a manager's entry for him
--   and the Super Admin's entry all insert into this table. The count is serialised by the advisory seat
--   lock `phoenix_crm_save_visit` already takes. The trigger's WHEN clause means an ordinary visit pays
--   nothing for it.
--   A visit that is REFUSED or still waiting for approval still counts: the rep went, and the cap is on
--   the going.
--
-- ROLLBACK
--   drop trigger if exists phoenix_crm_visits_offplan_cap on public.phoenix_crm_visits;
--   drop function if exists public.phoenix_crm_offplan_visit_cap();
--   alter table public.phoenix_crm_settings drop column if exists offplan_daily_cap, drop column if exists offplan_weekly_cap;
--   Nothing is rewritten or deleted by this migration, so there is no pre-image to take.

begin;

alter table public.phoenix_crm_settings
  add column if not exists offplan_daily_cap integer not null default 2,
  add column if not exists offplan_weekly_cap integer not null default 8;

alter table public.phoenix_crm_settings
  drop constraint if exists phoenix_crm_settings_offplan_daily_cap_check,
  drop constraint if exists phoenix_crm_settings_offplan_weekly_cap_check;
alter table public.phoenix_crm_settings
  add constraint phoenix_crm_settings_offplan_daily_cap_check check (offplan_daily_cap >= 1 and offplan_daily_cap <= 20),
  add constraint phoenix_crm_settings_offplan_weekly_cap_check check (offplan_weekly_cap >= 1 and offplan_weekly_cap <= 100);

comment on column public.phoenix_crm_settings.offplan_daily_cap is
  'The most DOCTORS a rep may visit out of plan in one visit day (owner, 2026-10-10: 2). Enforced at the door by phoenix_crm_visits_offplan_cap.';
comment on column public.phoenix_crm_settings.offplan_weekly_cap is
  'The most DOCTORS a rep may visit out of plan in one field week, Saturday to Thursday (owner, 2026-10-10: 8). Enforced at the door by phoenix_crm_visits_offplan_cap.';

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
  -- The caps are the SETTINGS. A settings row that could not be read falls back to the owner's own
  -- numbers rather than to no cap at all.
  select s.offplan_daily_cap, s.offplan_weekly_cap into v_daily, v_weekly
  from public.phoenix_crm_settings s where s.id = 1;
  v_daily := coalesce(v_daily, 2);
  v_weekly := coalesce(v_weekly, 8);

  -- Saturday = 0 ... Friday = 6, so a Friday closes the week before it (calendar.ts fieldWeekStart).
  v_week_start := new.visit_date - ((extract(dow from new.visit_date)::integer + 1) % 7);

  -- The day first, since it is the tighter number and the one a rep meets first.
  select count(distinct v.customer_id) into v_day_doctors
  from public.phoenix_crm_visits v
  where v.seat_id = new.seat_id
    and v.is_test = new.is_test
    and v.unplanned_kind = 'out_of_plan'
    and v.list_type in ('AM', 'PM')
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

drop trigger if exists phoenix_crm_visits_offplan_cap on public.phoenix_crm_visits;
create trigger phoenix_crm_visits_offplan_cap
  before insert on public.phoenix_crm_visits
  for each row
  when (new.unplanned_kind = 'out_of_plan' and new.list_type in ('AM', 'PM'))
  execute function public.phoenix_crm_offplan_visit_cap();

notify pgrst, 'reload schema';

commit;
