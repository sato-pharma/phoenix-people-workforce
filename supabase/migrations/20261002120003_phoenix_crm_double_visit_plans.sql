-- phoenix_crm_double_visit_plans
--
-- WHAT THIS CHANGES:
--   1. One new table, public.phoenix_crm_double_visit_plans — the district manager's double-visit
--      plan: for a field day and a half of it (AM or PM), the rep seat of his team he joins. One row
--      per (manager, day, half, world), so a day holds at most one AM and one PM double visit.
--   2. One new function, public.phoenix_crm_save_double_visit_slot(p jsonb) — sets, changes or clears
--      ONE half-day of that plan under its own lock. It refuses a day that has passed, a Friday, a
--      Thursday afternoon, a week beyond the coming one, and a half-day another screen changed first.
--
-- WHY (owner, 2026-10-02):
--   The district manager plans, for the coming field week, which of his reps he joins on which day,
--   AM or PM, and afterwards reads it against what happened: a planned double visit is DONE when he
--   was on a visit on that rep's seat that half-day — the manager report's own rule
--   (phoenix_crm_report_manager_visits: the manager on a double or chain visit, or the senior on a
--   chain), read from the countable visits.
--
--   THE REP DOES NOT SEE IT (owner, 2026-10-02: "Rep does not see it"). Nothing here notifies
--   anyone, and the only reader is src/lib/phoenix-crm/server/double-visit-plans.ts, which serves that
--   district manager, the SFE Manager and the Super Admin and refuses everyone else.
--
--   The function never asks WHO the actor is — the application proves that and passes the manager
--   whose plan it is. Which rep seats are his team, and which days are public holidays, are the
--   application's too: the organogram and the holiday calendar live outside this module's tables.
--   What the database keeps for itself is the calendar: the Cairo day, the field week, the two halves.
--
--   is_test is the module's test world, as on every Phoenix CRM table: the Super Admin trying the
--   plan in test mode, and a test account working as the district manager it mirrors, write test rows
--   only, and no real reader ever reads one.
--
-- ROLLBACK:
--   drop function if exists public.phoenix_crm_save_double_visit_slot(jsonb);
--   drop table if exists public.phoenix_crm_double_visit_plans;
--   (Nothing else reads the table. Dropping it loses the plans made since it went live.)
--
-- Verification after apply:
--   select relrowsecurity from pg_class where relname = 'phoenix_crm_double_visit_plans';                    -- t
--   select prosecdef from pg_proc where proname = 'phoenix_crm_save_double_visit_slot';                      -- t
--   select has_function_privilege('anon', 'public.phoenix_crm_save_double_visit_slot(jsonb)', 'execute');   -- f
--   select has_table_privilege('authenticated', 'public.phoenix_crm_double_visit_plans', 'select');         -- f
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration is additive: one new table and one new function, no existing row touched.

begin;
set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_double_visit_plans (
  id uuid primary key default gen_random_uuid(),
  -- The district manager whose plan this is (upper case, as every hr id in the module is stored).
  manager_hr_id text not null,
  week_start date not null,
  plan_date date not null,
  half text not null,
  -- The rep seat he joins, and the rep who held it when he planned it.
  seat_id text not null,
  rep_hr_id text not null,
  line_code text,
  -- Who saved it: the district manager himself, or the Super Admin trying it in the test world.
  entered_by_hr_id text not null,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_double_visit_plans_half check (half in ('AM', 'PM')),
  constraint phoenix_crm_double_visit_plans_saturday check (extract(isodow from week_start) = 6),
  -- Saturday to Thursday of its own week: never a Friday, which is week_start + 6.
  constraint phoenix_crm_double_visit_plans_in_week check (plan_date between week_start and week_start + 5),
  -- Thursday is a morning (calendar.ts planDayListTypes).
  constraint phoenix_crm_double_visit_plans_thursday_am check (not (extract(isodow from plan_date) = 4 and half = 'PM')),
  constraint phoenix_crm_double_visit_plans_upper check (manager_hr_id = upper(manager_hr_id) and rep_hr_id = upper(rep_hr_id))
);

comment on table public.phoenix_crm_double_visit_plans is
  'The district manager''s double-visit plan (owner, 2026-10-02): for each field day and half of it, the rep seat of his team he joins. Read by that district manager, the SFE Manager and the Super Admin only; the rep never sees it and nothing notifies anyone. A planned half-day is done when the manager was on a countable visit on that seat that half-day.';

-- One rep per half-day per manager per world: a second pick of the same half-day replaces the first.
create unique index if not exists phoenix_crm_double_visit_plans_slot_uniq
  on public.phoenix_crm_double_visit_plans (manager_hr_id, plan_date, half, is_test);
create index if not exists phoenix_crm_double_visit_plans_week_idx
  on public.phoenix_crm_double_visit_plans (week_start, is_test, manager_hr_id);

-- The same four statements, in the same order, as every other table in this module. Revoking from
-- public also strips service_role (a member of it), so the grant that follows is mandatory. The
-- `drop policy if exists` keeps the file replayable.
alter table public.phoenix_crm_double_visit_plans enable row level security;
drop policy if exists phoenix_crm_double_visit_plans_service_role on public.phoenix_crm_double_visit_plans;
create policy phoenix_crm_double_visit_plans_service_role
  on public.phoenix_crm_double_visit_plans for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_double_visit_plans from public, anon, authenticated;
grant all on table public.phoenix_crm_double_visit_plans to service_role;

-- ── Setting, changing or clearing one half-day ─────────────────────────────────────────────────
--
-- p: manager_hr_id, actor_hr_id, plan_date, half, seat_id (null clears the half-day), rep_hr_id,
--    line_code, expected_seat_id (the rep seat the screen showed: null for an empty half-day), is_test
create or replace function public.phoenix_crm_save_double_visit_slot(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_manager text := upper(nullif(trim(coalesce(p ->> 'manager_hr_id', '')), ''));
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_date date := nullif(p ->> 'plan_date', '')::date;
  v_half text := coalesce(p ->> 'half', '');
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_rep text := upper(nullif(trim(coalesce(p ->> 'rep_hr_id', '')), ''));
  v_line text := nullif(trim(coalesce(p ->> 'line_code', '')), '');
  v_expected text := nullif(trim(coalesce(p ->> 'expected_seat_id', '')), '');
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_week date;
  v_this_week date;
  v_row public.phoenix_crm_double_visit_plans%rowtype;
  v_found boolean;
begin
  if v_manager is null or v_actor is null or v_date is null or v_half not in ('AM', 'PM') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- A pick names its rep; a clear names nobody.
  if v_seat is not null and v_rep is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- The field week: Saturday to Wednesday, AM and PM; Thursday a morning; never a Friday.
  if extract(isodow from v_date) = 5 or (extract(isodow from v_date) = 4 and v_half = 'PM') then
    raise exception 'phoenix_crm:double_visit_not_field_time';
  end if;
  -- A day that has passed keeps its plan, so plan against actual still reads what was planned.
  if v_date < v_today then
    raise exception 'phoenix_crm:double_visit_day_passed';
  end if;
  -- The Saturday that starts a day's field week (isodow: Saturday 6, Sunday 7; a Friday, 5, belongs to
  -- the week before it) — calendar.ts fieldWeekStart in SQL.
  v_week := v_date - ((extract(isodow from v_date)::integer + 1) % 7);
  v_this_week := v_today - ((extract(isodow from v_today)::integer + 1) % 7);
  -- This week from today on, and the coming week. Never a week beyond it.
  if v_week > v_this_week + 7 then
    raise exception 'phoenix_crm:double_visit_week_ahead';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('phoenix_crm:double_visit:' || v_manager || ':' || v_date::text || ':' || v_half || ':' || v_is_test::text)
  );

  select d.* into v_row
  from public.phoenix_crm_double_visit_plans d
  where d.manager_hr_id = v_manager and d.plan_date = v_date and d.half = v_half and d.is_test = v_is_test
  for update;
  v_found := found;

  -- The screen sends the rep seat it showed for this half-day (null for none). Anything else means
  -- another screen changed it first, and writing over it would lose that change without a word.
  if (case when v_found then v_row.seat_id else null end) is distinct from v_expected then
    raise exception 'phoenix_crm:double_visit_changed';
  end if;

  if v_seat is null then
    if v_found then
      delete from public.phoenix_crm_double_visit_plans d where d.id = v_row.id;
    end if;
  elsif v_found then
    update public.phoenix_crm_double_visit_plans d
    set seat_id = v_seat,
        rep_hr_id = v_rep,
        line_code = v_line,
        entered_by_hr_id = v_actor,
        updated_at = now()
    where d.id = v_row.id;
  else
    insert into public.phoenix_crm_double_visit_plans
      (manager_hr_id, week_start, plan_date, half, seat_id, rep_hr_id, line_code, entered_by_hr_id, is_test)
    values
      (v_manager, v_week, v_date, v_half, v_seat, v_rep, v_line, v_actor, v_is_test);
  end if;

  return jsonb_build_object(
    'manager_hr_id', v_manager,
    'week_start', v_week,
    'plan_date', v_date,
    'half', v_half,
    'seat_id', v_seat,
    'is_test', v_is_test
  );
end;
$$;

revoke execute on function public.phoenix_crm_save_double_visit_slot(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_save_double_visit_slot(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
