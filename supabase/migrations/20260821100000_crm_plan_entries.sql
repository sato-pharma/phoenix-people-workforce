-- Rep Doctor Lists — mirror of the iReports360 PLAN endpoints.
--
-- Phoenix has always synced what reps DID (ireports360_visits) and never what they were ASSIGNED.
-- The vendor's collection exposes four planning endpoints Phoenix never called; the two GETs are
-- read-only and carry, per rep, the doctors on that rep's list with the vendor's own grade,
-- speciality and locality. Measured live 2026-08-21 for 1-21 August: 16,328 planned calls across
-- 77 reps and 8,855 distinct contacts, speciality filled on 100% of rows.
--
-- WHY THIS IS NOT A DUPLICATE OF DOCTOR COVERAGE. sfe-doctor-coverage.ts builds its panel from
-- VISIT history, so a doctor who is on a rep's list but has never been visited has no row anywhere
-- and is structurally invisible to that board. That is the population this table adds: on the same
-- August window, 2,941 of 7,085 planned rep-to-doctor pairs (42%) were never visited at all.
--
-- WHY NOT `weekly_plans`. Phoenix already owns an unrelated module of that name
-- (src/lib/weekly-planning/*, /admin/weekly-plans) where reps submit plans INSIDE Phoenix and
-- managers review them. This table is the CRM vendor's plan, pulled from iReports360; the two must
-- never be confused, hence the ireports360_ prefix that every other mirror table here uses.

create table if not exists public.ireports360_plan_entries (
  -- The vendor's own row id (`id`), unique per planned call. Upsert key, exactly like
  -- ireports360_visits.crm_visit_id.
  crm_plan_entry_id bigint primary key,
  -- Only 'weekly' is written today: the weekly endpoint covers all 77 active reps while the
  -- monthly one covered 17 on the same date, so weekly is the complete list and monthly is not.
  -- The column exists so adding the monthly pull later is a sync change, not a schema rewrite.
  plan_kind text not null default 'weekly' check (plan_kind in ('weekly', 'monthly')),
  -- The vendor's plan HEADER id (`planID`) this row belongs to. Many entries share one header;
  -- it is the unit the two PUT .../status endpoints approve. Kept so a later approval feature can
  -- address a header without re-deriving it.
  crm_plan_id integer,
  -- Weekly: the planned call date. Null on a monthly entry, which has no day.
  plan_date date,
  -- Monthly only: the month this list covers, and how many calls that contact is planned for.
  plan_month smallint check (plan_month is null or (plan_month between 1 and 12)),
  plan_year smallint,
  plan_frequency smallint,
  agent_crm_id bigint not null,
  -- Resolved through the same identity waterfall as a visit. The plan payload carries NO agent
  -- name field at all (keys are id/planID/date/agentID/contactID/contactName/grade/region/
  -- speciality/appm/startAM/startPM/planStatus), so resolution is crm-id-only, exactly like a
  -- check-in row.
  agent_hr_id text,
  contact_crm_id bigint,
  contact_name text,
  -- Normalized by normalizeContactGrade, same as ireports360_visits.crm_contact_grade: the vendor
  -- sends "A", "A ", " A", "B   " and "b" for the same two grades.
  contact_grade text,
  crm_region_name text,
  speciality text,
  -- Vendor field `appm`, normalized by normalizeAmpm (same inconsistent casing as on a visit).
  ampm text,
  start_am text,
  start_pm text,
  -- Vendor approval state of the plan header: 0 = New, 1 = Supervisor Verified,
  -- 2 = Area Manager Verified.
  plan_status smallint,
  raw_payload jsonb,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The board's primary read: every planned entry for a window, grouped by rep.
create index if not exists ireports360_plan_entries_agent_date_idx
  on public.ireports360_plan_entries (agent_crm_id, plan_date);

-- The join back to what actually happened is on (agent_crm_id, contact_crm_id); this index serves
-- the contact half and the "which reps have this doctor" question.
create index if not exists ireports360_plan_entries_contact_idx
  on public.ireports360_plan_entries (contact_crm_id)
  where contact_crm_id is not null;

create index if not exists ireports360_plan_entries_plan_date_idx
  on public.ireports360_plan_entries (plan_date)
  where plan_date is not null;

alter table public.ireports360_plan_entries enable row level security;

-- Same posture as every other CRM mirror table: service-role only, no anon/authenticated grant.
-- Visibility in this app is application-scoped (the reader asserts the permission), and the board
-- that reads this is Super Admin only for now.
revoke all on table public.ireports360_plan_entries from anon, authenticated;

grant select, insert, update, delete on table public.ireports360_plan_entries to service_role;

drop policy if exists ireports360_plan_entries_service_role on public.ireports360_plan_entries;
create policy ireports360_plan_entries_service_role
  on public.ireports360_plan_entries
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.ireports360_plan_entries is
  'Mirror of the iReports360 weekly/monthly PLAN endpoints -- one row per planned call (vendor `id`). This is the ASSIGNED doctor list per rep, the counterpart to ireports360_visits (what was actually done). Not related to Phoenix''s own weekly-planning module (src/lib/weekly-planning), which is a different thing with a similar name.';
