-- phoenix_crm_plans_everywhere
--
-- WHAT THIS CHANGES (owner, 2026-10-02 — "Yes, in the second PR"): a STARTED team's weekly plans count
--   on every screen outside Phoenix CRM that reads the iReports360 plan copy — Reps List statuses, the
--   KPIs board's coverage and frequency, SFE doctor coverage, the Reps Weekly Plans tab and its plan
--   actuals — INSTEAD of its reps' iReports360 plan entries, for exactly the days the visits do
--   (20261002123958_phoenix_crm_visits_everywhere.sql: the same team starts, the same people, the same
--   days). So Delta (1)'s reps stop reading "No plan" / "Off plan" from Saturday 3 October, and nothing
--   is counted twice.
--
--   1. public.phoenix_crm_plan_day_status(plan, day, as_of) — what one plan said about one day at one
--      instant: 'submitted', 'approved', or null (not a sent day). It is phoenix_crm_save_visit's own
--      "WAS HE PLANNED?" (v_on_sent_plan, 20261002125244), restated for one plan: the plan's LATEST
--      event as of the instant reaching 'submitted' or 'approved' — or the latest being a ONE-DAY RETURN
--      of ANOTHER day that no edit request acknowledged since has opened ("Still planned", owner,
--      2026-10-02); then the day stands as the week stood when the day was returned (the RETURN event's
--      from_status — plan-rules.ts `planDayStatus`'s returnedFrom). A draft, a week returned whole, the
--      returned day itself and a never-sent plan answer null. Plan EVENTS decide it, never
--      phoenix_crm_plans.status alone, and a 'saved' event is never read as a change of status: it
--      carries the plan's own status and, while one day stands returned, that day in its details
--      (20261002142625), exactly as the save's rule reads it. tests/phoenix-crm-visits-everywhere.test.ts
--      holds its clauses to the save's own, so the two cannot drift.
--   2. crm_plan_entries_unified gains a Phoenix branch: every item of a real (not test) weekly plan on a
--      started team's territory whose day was SENT AS OF THAT DAY (the end of that Cairo day, or now for
--      a day still to come), carried for the rep who sat on that territory that day, in the vendor
--      shape — `plan_status` 1 (verified) when the week is approved NOW, else 0 (pending), the vendor's
--      own two words, constant across one plan as the plan boards read it. Its iReports360 branch leaves
--      out the dated entries of the same people for the same days — the team's reps and its district
--      manager ("Yes, the whole team") — by the hr id, or by the CRM id on a row that carries no hr id
--      (the plan mirror leaves a share of them blank). A monthly vendor plan carries no date and is not
--      split by a start (none exists for Delta (1) in October, measured 2026-10-02).
--   3. crm_checkins_unified gains a Phoenix branch (owner, 2026-10-02 — "each visit's silent location
--      counts as a check-in on the SFE and manager screens. Never on the rep's own screens"): each
--      countable Phoenix visit of a started team, within its start, that carries a position, as that
--      day's check-in — its capture time, its position, the rep and the customer, and no integrity column
--      at all. Its iReports360 branch leaves out the same people's check-ins for the same days. The app
--      reads the Phoenix rows only on a screen no rep can reach (queryCheckins `includePhoenixVisits`).
--
-- HOW A PHOENIX PLAN DAY LOOKS IN THE VENDOR SHAPE:
--   crm_plan_entry_id   NEGATIVE: -1 - (52 bits of md5(item id)) — every vendor id is positive.
--   crm_plan_id         NEGATIVE: -1 - (30 bits of md5(plan id)) — the column is an integer; the plan
--                       verification route already answers a negative id "reviewed on Phoenix's plan
--                       review screen", never a vendor write.
--   plan_kind           'weekly' (a rep plans one week; there is no monthly Phoenix plan for a rep).
--   agent_*             the rep who sat on the territory that day, with his employees.crm_id.
--   contact_*           the customer's reference_contact_crm_id (his iReports360 contact), name and grade;
--                       a customer created new in Phoenix has no contact id, and every per-doctor reader
--                       skips a row without one — his plan and his visits alike.
--   ampm                the item's list (AM / PM). A pharmacy is never planned as a customer.
--   crm_region_name     NULL, as on a Phoenix visit.
--   synced_at           when the plan or the item last changed.
--
-- WHY: the visits now come from Phoenix for a started team, but every reader that joins them to the
--   iReports360 plan copy still found no plan from the start — so every Delta (1) visit read "Off plan"
--   and every doctor "No plan" — and every GPS reader on the SFE and manager screens (the CRM Check-ins
--   tab, GPS brick coverage, the managers' boards) found no check-in at all.
--
-- ORDER: after 20261002123958_phoenix_crm_visits_everywhere.sql (it reads phoenix_crm_started_team_reps()
--   and phoenix_crm_started_team_seats()), and before the code that asks queryCheckins for Phoenix rows —
--   though that code is safe on either shape: before this file it simply finds none. No code names a new
--   column: the plan view keeps its 23 columns and the check-in view its 16, exactly.
--
-- ROLLBACK:
--   begin;
--   -- re-apply crm_plan_entries_unified and crm_checkins_unified from
--   -- 20260925150000_drop_crm_native_pilot_tables.sql (with their revokes), then:
--   drop function if exists public.phoenix_crm_plan_day_status(uuid, date, timestamptz);
--   notify pgrst, 'reload schema';
--   commit;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This file deletes and rewrites no data. It changes what every plan reader returns for a started team —
-- Reps List, the KPIs board, SFE doctor coverage and the Reps Weekly Plans tab — and which check-ins the
-- check-in readers find for its people: none from iReports360 within the start, and its Phoenix visits
-- where a reader asks. Among the check-in readers are money-adjacent ones (the outstation visit workload
-- and the claim validation behind it), which read iReports360 check-ins only and so find none for a
-- started team's people within the start — as they would anyway, since those people no longer use
-- iReports360. None of them writes, approves or publishes a deduction, an allowance or a payroll row.

begin;
set local lock_timeout = '5s';

-- ── 1. What one plan said about one day ─────────────────────────────────────────────────────────────

create or replace function public.phoenix_crm_plan_day_status(p_plan_id uuid, p_day date, p_as_of timestamptz)
returns text
language sql
stable
set search_path to 'public'
as $$
  -- The plan's LATEST event as of the instant — phoenix_crm_save_visit's own subquery, word for word, for
  -- one plan (tests/phoenix-crm-visits-everywhere.test.ts holds the two together).
  select case
    when latest.to_status in ('submitted', 'approved') then latest.to_status
    when latest.to_status = 'returned'
      and p_day <> nullif(latest.details ->> 'returned_day', '')::date
      and not exists (
        select 1
        from public.phoenix_crm_plan_edit_requests r
        where r.plan_id = p_plan_id
          and r.hr_acknowledged_at > latest.created_at
          and r.hr_acknowledged_at <= p_as_of
      )
    -- What the week was when the day was returned: the RETURN event itself, never a later save (a save
    -- writes from_status = to_status = the plan's status, and is never a change of status).
    then coalesce((
      select case when rt.from_status = 'approved' then 'approved' end
      from public.phoenix_crm_plan_events rt
      where rt.plan_id = p_plan_id
        and rt.event_type = 'returned'
        and rt.created_at <= p_as_of
      order by rt.created_at desc, rt.id desc
      limit 1
    ), 'submitted')
  end
  from (
    select e.to_status, e.details, e.created_at
    from public.phoenix_crm_plan_events e
    where e.plan_id = p_plan_id
      and e.to_status is not null
      and e.created_at <= p_as_of
    order by e.created_at desc, e.id desc
    limit 1
  ) latest
$$;

comment on function public.phoenix_crm_plan_day_status(uuid, date, timestamptz) is
  'What one weekly plan said about one day at one instant: submitted, approved, or null (not a sent day). phoenix_crm_save_visit''s own "was he planned" rule for one plan, with a one-day return of another day leaving the week as it stood.';

revoke execute on function public.phoenix_crm_plan_day_status(uuid, date, timestamptz) from public, anon, authenticated;
grant execute on function public.phoenix_crm_plan_day_status(uuid, date, timestamptz) to service_role;

-- ── 2. The plan door ───────────────────────────────────────────────────────────────────────────────
-- The iReports360 branch is 20260925150000's, word for word, with its one condition bracketed and TWO
-- clauses added (the started teams' reps within a start: by hr id, and by CRM id on a row with no hr
-- id). The Phoenix branch is new. The 23 columns keep their names, types and order.
create or replace view public.crm_plan_entries_unified
  with (security_invoker = true)
as
select
  pe.crm_plan_entry_id,
  pe.plan_kind,
  pe.crm_plan_id,
  pe.plan_date,
  pe.plan_month,
  pe.plan_year,
  pe.plan_frequency,
  pe.agent_crm_id,
  pe.agent_hr_id,
  pe.contact_crm_id,
  pe.contact_name,
  pe.contact_grade,
  pe.crm_region_name,
  pe.speciality,
  pe.ampm,
  pe.start_am,
  pe.start_pm,
  pe.plan_status,
  pe.raw_payload,
  pe.synced_at,
  pe.created_at,
  pe.updated_at,
  'ireports360'::text as source
from public.ireports360_plan_entries pe
where (pe.plan_date is null or pe.plan_date < coalesce((select c.cutover_date from public.crm_cutover c where c.id), 'infinity'::date))
  -- Within a start, a started team's people (its reps and its district manager) are planned from Phoenix
  -- CRM only.
  and not exists (
    select 1
      from public.phoenix_crm_started_team_reps() r
     where r.hr_key = lower(btrim(pe.agent_hr_id))
       and pe.plan_date >= r.counted_from
       and (r.counted_until is null or pe.plan_date < r.counted_until)
  )
  -- A plan row the mirror left without an hr id is still his, by his CRM id.
  and not exists (
    select 1
      from public.phoenix_crm_started_team_reps() r
     where nullif(btrim(pe.agent_hr_id), '') is null
       and r.agent_crm_id = pe.agent_crm_id
       and pe.plan_date >= r.counted_from
       and (r.counted_until is null or pe.plan_date < r.counted_until)
  )
union all
select
  -1 - ('x' || substr(md5(i.id::text), 1, 13))::bit(52)::bigint,
  'weekly'::text,
  -1 - ('x' || substr(md5(pl.id::text), 1, 8))::bit(30)::integer,
  i.plan_date,
  extract(month from i.plan_date)::smallint,
  extract(year from i.plan_date)::smallint,
  null::smallint,
  r.agent_crm_id,
  r.hr_id,
  customer.reference_contact_crm_id,
  customer.name,
  customer.grade,
  null::text,
  customer.speciality,
  i.list_type,
  null::text,
  null::text,
  -- The week's verification as it stands NOW — the vendor's own 1 / 0, the same on every day of a plan.
  (case when public.phoenix_crm_plan_day_status(pl.id, i.plan_date, now()) = 'approved' then 1 else 0 end)::smallint,
  null::jsonb,
  greatest(pl.updated_at, i.updated_at),
  i.created_at,
  i.updated_at,
  'phoenix'::text
from public.phoenix_crm_plan_items i
join public.phoenix_crm_plans pl on pl.id = i.plan_id
-- The rep who sat on the territory that day, within the team's start — the same people and days the
-- iReports360 branch above leaves out.
join public.phoenix_crm_started_team_reps() r
  on r.seat_id = pl.seat_id
 and i.plan_date >= r.counted_from
 and (r.counted_until is null or i.plan_date < r.counted_until)
join public.phoenix_crm_customers customer on customer.id = i.customer_id
where not pl.is_test
  -- SENT AS OF THAT DAY: by the end of that Cairo day, or by now for a day still to come.
  and public.phoenix_crm_plan_day_status(
        pl.id,
        i.plan_date,
        least(now(), (i.plan_date + 1)::timestamp at time zone 'Africa/Cairo')
      ) is not null;

comment on view public.crm_plan_entries_unified is
  'Every planned call the plan door serves: iReports360 plan entries, and — for a team in '
  'phoenix_crm_team_starts, within its start — that team''s Phoenix weekly plans, day by day as sent, '
  'INSTEAD of its reps'' iReports360 entries (owner, 2026-10-02). Phoenix rows: real only, source '
  '''phoenix'', negative ids, plan_status 1 when the week is approved now. '
  'See supabase/migrations/20261002142118_phoenix_crm_plans_everywhere.sql.';

revoke all on table public.crm_plan_entries_unified from anon, authenticated;

-- ── 3. The check-in door ───────────────────────────────────────────────────────────────────────────
-- Owner, 2026-10-02 ("Yes, in the second PR"): each countable Phoenix visit's silent location counts as
-- that day's check-in on the SFE and manager screens — never on the rep's own screens. The iReports360
-- branch is 20260925150000's, word for word, with TWO clauses added: the same people and days the visits
-- door leaves out (a started team's reps and its district manager, within its start — by hr id, and by
-- CRM id on a check-in with no hr id). The Phoenix branch is new: each countable Phoenix visit of a
-- started team, within its start, that carries a captured position — its time, its position, who and
-- whom, and NOTHING ELSE: no accuracy, flag, distance, skew, photo, dwell, capture source or offline
-- column (golden rule #1 — those stay on the integrity board). The 16 columns keep their names, types
-- and order, so crm_visits_checkin_flags (it reads source = 'ireports360' only) and every caller keep
-- working. The app reads the Phoenix rows only where it asks for them (src/lib/crm/reads.ts
-- queryCheckins `includePhoenixVisits`): every other reader — every screen a rep can reach — reads
-- iReports360 check-ins only.
create or replace view public.crm_checkins_unified
  with (security_invoker = true)
as
select
  c.id,
  c.crm_checkin_id,
  c.agent_crm_id,
  c.agent_hr_id,
  c.contact_crm_id,
  c.contact_name,
  c.lat,
  c.lon,
  c.address,
  c.check_date,
  c.raw_payload,
  c.synced_at,
  c.created_at,
  c.updated_at,
  'ireports360'::text as source,
  c.agent_crm_id as exclusion_crm_id
from public.ireports360_checkins c
where c.check_date < coalesce(
  (select k.cutover_date::timestamp at time zone 'UTC' from public.crm_cutover k where k.id),
  'infinity'::timestamptz
)
  -- Within a start, a started team's people check in through Phoenix CRM only. A vendor check-in's
  -- day is its wall clock as stored (Cairo, labelled UTC — the vendor convention).
  and not exists (
    select 1
      from public.phoenix_crm_started_team_reps() r
     where r.hr_key = lower(btrim(c.agent_hr_id))
       and (c.check_date at time zone 'UTC')::date >= r.counted_from
       and (r.counted_until is null or (c.check_date at time zone 'UTC')::date < r.counted_until)
  )
  -- A check-in the sync could not give an hr id is still his, by his CRM id.
  and not exists (
    select 1
      from public.phoenix_crm_started_team_reps() r
     where nullif(btrim(c.agent_hr_id), '') is null
       and r.agent_crm_id = c.agent_crm_id
       and (c.check_date at time zone 'UTC')::date >= r.counted_from
       and (r.counted_until is null or (c.check_date at time zone 'UTC')::date < r.counted_until)
  )
union all
select
  p.id,
  -1 - ('x' || substr(md5(p.id::text), 1, 13))::bit(52)::bigint,
  case when agent.crm_id ~ '^[0-9]+$' then agent.crm_id::bigint end,
  coalesce(p.rep_hr_id, p.manager_hr_id),
  customer.reference_contact_crm_id,
  customer.name,
  p.lat,
  p.lon,
  null::text,
  (p.captured_at at time zone 'Africa/Cairo') at time zone 'UTC',
  null::jsonb,
  p.created_at,
  p.created_at,
  p.created_at,
  'phoenix'::text,
  coalesce(case when agent.crm_id ~ '^[0-9]+$' then agent.crm_id::bigint end, -1::bigint)
from public.phoenix_crm_countable_visits p
join public.phoenix_crm_started_team_seats() team
  on team.seat_id = p.seat_id
 and p.visit_date >= team.starts_on
 and (team.stops_on is null or p.visit_date < team.stops_on)
join public.phoenix_crm_customers customer on customer.id = p.customer_id
-- One row per person whatever the casing, so a person can never double a check-in.
left join (
  select distinct on (upper(btrim(e.hr_id))) upper(btrim(e.hr_id)) as hr_key, e.crm_id
    from public.employees e
   order by upper(btrim(e.hr_id)), e.hr_id
) agent on agent.hr_key = upper(btrim(coalesce(p.rep_hr_id, p.manager_hr_id)))
-- Real only, and only a visit whose position was read: a check-in is a time AND a place.
where not p.is_test
  and p.lat is not null
  and p.lon is not null;

comment on view public.crm_checkins_unified is
  'Every GPS check-in the read door serves: iReports360 check-ins, and — for a team in '
  'phoenix_crm_team_starts, within its start — each countable Phoenix CRM visit that carries a position, '
  'as that day''s check-in (time and position only), INSTEAD of its people''s iReports360 check-ins '
  '(owner, 2026-10-02). The app reads the Phoenix rows on SFE and manager screens only. '
  'See supabase/migrations/20261002142118_phoenix_crm_plans_everywhere.sql.';

revoke all on table public.crm_checkins_unified from anon, authenticated;

notify pgrst, 'reload schema';

commit;
