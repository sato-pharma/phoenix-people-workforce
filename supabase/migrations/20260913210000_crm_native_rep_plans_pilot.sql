-- Native rep plans — the PILOT (CRM phase 4).
--
-- WHAT THIS IS. Phoenix's own weekly plan, written by the rep: which doctor, which day, AM or PM
-- (owner decision 15), sent to the rep's nearest active manager, who verifies it or returns it with
-- a note (owner decision 16). Only the pilot line plans here, only for the pilot's days (decision 17):
-- the service reads the same crm_native_visit_pilots row the visit form reads.
--
-- WHAT IT DOES NOT TOUCH. iReports360 stays the plan of record for everyone, the pilot line included.
-- Nothing here touches an ireports360_* table, the plan-verification write-back is unchanged, and no
-- report, KPI or board reads these tables (decision 19). A cutover is a later phase.
--
-- WHAT IS HERE.
--   crm_native_plans        one plan per rep per field week (Saturday to Thursday), with a snapshot
--                           of the rep's line, area, region and manager. Its status moves IN PLACE —
--                           draft, submitted, verified, returned — so there are no revision rows to
--                           collide on a unique index (the audit's warning about employee_plan_*).
--                           `revision` rises with every change, so a manager can only decide the
--                           version on the screen. A decision is recorded as the manager the plan was
--                           sent to, by a check constraint, and a return must carry a note.
--   crm_native_plan_items   one row per rep, doctor and day FOR GOOD. Dropping a doctor sets
--                           removed_at; planning the doctor again clears it, so the id never changes
--                           (the vendor issues a new id on every re-save). The day must fall inside
--                           the plan's own week, never on a Friday, and Thursday is a morning only.
--                           The catch-all contact 100000 is refused.
--   crm_native_plan_events  append-only history: created, saved, submitted, reopened, verified,
--                           returned.
--   crm_native_visits.plan_item_id becomes a real uuid foreign key to the item a visit kept. It was
--                           added empty in phase 3 and nothing has written it.
--
-- RLS on, nothing granted to anon or authenticated; every read and write goes through the
-- service-role client behind the app's own permission and scope checks.

begin;

create table if not exists public.crm_native_plans (
  id uuid primary key default gen_random_uuid(),
  hr_id text not null references public.employees (hr_id),
  week_start date not null,
  week_end date not null,
  line_name text not null,
  area_name text,
  region_name text,
  manager_hr_id text,
  status text not null default 'draft',
  revision integer not null default 1,
  verifier_hr_id text references public.employees (hr_id),
  submitted_at timestamptz,
  decided_at timestamptz,
  decided_by text,
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_native_plans_one_per_week unique (hr_id, week_start),
  constraint crm_native_plans_identity unique (id, hr_id, week_start),
  constraint crm_native_plans_week_starts_saturday check (extract(isodow from week_start) = 6),
  constraint crm_native_plans_week_end check (week_end = week_start + 5),
  constraint crm_native_plans_status check (status in ('draft', 'submitted', 'verified', 'returned')),
  constraint crm_native_plans_revision check (revision >= 1),
  -- The workflow, held by the database. A decision is always the verifier's own, and a return says why.
  constraint crm_native_plans_workflow check (
    case status
      when 'draft' then submitted_at is null and verifier_hr_id is null
        and decided_at is null and decided_by is null and decision_note is null
      when 'submitted' then submitted_at is not null and verifier_hr_id is not null
        and decided_at is null and decided_by is null and decision_note is null
      when 'verified' then submitted_at is not null and verifier_hr_id is not null
        and decided_at is not null and decided_by = verifier_hr_id
      when 'returned' then submitted_at is not null and verifier_hr_id is not null
        and decided_at is not null and decided_by = verifier_hr_id
        and decision_note is not null and btrim(decision_note) <> ''
      else false
    end
  )
);

comment on table public.crm_native_plans is
  'Native (Phoenix-entered) weekly rep plans — PILOT. Verified or returned only by the manager the plan was sent to; never by the system. Read by nothing but the native-visits module until the cutover.';

create index if not exists crm_native_plans_verifier_idx
  on public.crm_native_plans (verifier_hr_id, status);

create table if not exists public.crm_native_plan_items (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null,
  hr_id text not null references public.employees (hr_id),
  week_start date not null,
  plan_date date not null,
  shift text not null,
  contact_crm_id bigint not null references public.crm_contacts (contact_crm_id),
  contact_name text,
  contact_speciality text,
  contact_grade text,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The item belongs to ITS rep's plan for THAT week — a composite key, so it cannot drift to another.
  constraint crm_native_plan_items_plan foreign key (plan_id, hr_id, week_start)
    references public.crm_native_plans (id, hr_id, week_start) on delete restrict,
  -- One row per rep, doctor and day for good: the stable id.
  constraint crm_native_plan_items_one_per_contact_day unique (hr_id, contact_crm_id, plan_date),
  constraint crm_native_plan_items_shift check (shift in ('AM', 'PM')),
  constraint crm_native_plan_items_real_contact check (contact_crm_id <> 100000),
  constraint crm_native_plan_items_in_week check (plan_date >= week_start and plan_date <= week_start + 5),
  constraint crm_native_plan_items_thursday_morning check (extract(isodow from plan_date) <> 4 or shift = 'AM')
);

comment on table public.crm_native_plan_items is
  'One planned doctor per rep and day, with a stable id: a dropped doctor is marked removed, never deleted, and planning the doctor again restores the same row.';

create index if not exists crm_native_plan_items_plan_idx
  on public.crm_native_plan_items (plan_id);

create table if not exists public.crm_native_plan_events (
  id bigint generated always as identity primary key,
  plan_id uuid not null references public.crm_native_plans (id) on delete restrict,
  event text not null,
  actor_hr_id text,
  revision integer,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint crm_native_plan_events_event check (
    event in ('created', 'saved', 'submitted', 'reopened', 'verified', 'returned')
  )
);

comment on table public.crm_native_plan_events is
  'Append-only history of every native rep plan: created, saved, submitted, reopened, verified, returned.';

create index if not exists crm_native_plan_events_plan_idx
  on public.crm_native_plan_events (plan_id, created_at);

-- The visit → plan item link. Phase 3 added the column as text and nothing has written it; it becomes
-- a uuid with a real foreign key. Written only when the visit is created, to the rep's own live item
-- for the same doctor and day.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'crm_native_visits'
      and column_name = 'plan_item_id' and data_type = 'text'
  ) then
    alter table public.crm_native_visits
      alter column plan_item_id type uuid using nullif(btrim(plan_item_id), '')::uuid;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'crm_native_visits_plan_item_fk'
  ) then
    alter table public.crm_native_visits
      add constraint crm_native_visits_plan_item_fk foreign key (plan_item_id)
      references public.crm_native_plan_items (id) on delete restrict;
  end if;
end
$$;

create index if not exists crm_native_visits_plan_item_idx
  on public.crm_native_visits (plan_item_id)
  where plan_item_id is not null;

alter table public.crm_native_plans enable row level security;
alter table public.crm_native_plan_items enable row level security;
alter table public.crm_native_plan_events enable row level security;

revoke all on table public.crm_native_plans from anon, authenticated;
revoke all on table public.crm_native_plan_items from anon, authenticated;
revoke all on table public.crm_native_plan_events from anon, authenticated;
revoke all on sequence public.crm_native_plan_events_id_seq from anon, authenticated;

commit;

-- ROLLBACK. Safe only while no rep has saved a real plan (check `select count(*) from
-- public.crm_native_plans` first — a pilot plan is evidence, and production has no PITR):
--   begin;
--   drop index if exists public.crm_native_visits_plan_item_idx;
--   alter table public.crm_native_visits drop constraint if exists crm_native_visits_plan_item_fk;
--   alter table public.crm_native_visits alter column plan_item_id type text using plan_item_id::text;
--   drop table if exists public.crm_native_plan_events;
--   drop table if exists public.crm_native_plan_items;
--   drop table if exists public.crm_native_plans;
--   commit;
