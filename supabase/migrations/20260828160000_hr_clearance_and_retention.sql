-- Phase 6 of the 2026-08-28 HR role rebuild: the two things Phoenix genuinely does not have.
--
-- Every other line of both job descriptions maps onto a module that already exists. These two
-- do not, and each is named in a numbered JD section:
--
--   ops 6  - Resignation, Clearance & Offboarding
--            "coordinate clearance across departments and confirm evidence of completion before
--             final settlement". Phoenix records the RESIGNATION (employee_resignations, 54 rows
--             on 2026-08-28, 46 of them in the last 90 days) and nothing at all about clearance.
--
--   hrbp 3 - Retention & Employee Experience
--            "conduct structured stay discussions and exit interviews, and summarise them into
--             themes". Nothing captures either today.
--
-- WHY CLEARANCE IS NOT ROUTED BY DEPARTMENT, despite the JD saying "across departments".
-- Measured on production before this was designed: `employees.department_name` is NULL for all
-- 103 active employees, and the `departments` table holds 11 rows of which at least one ("Active",
-- id 3) is not a department at all. Routing sign-off at a column nobody populates would produce a
-- checklist that silently addresses nobody. So clearance runs on its own STATION catalogue -
-- seeded below, editable in the UI, and independent of `departments`. If department data is ever
-- filled in, a station can carry a department_id then; it cannot depend on one now.
--
-- WHY THERE IS NO OVERRIDE ON THE SETTLEMENT GATE.
-- The obvious shape is "block release until everything is cleared, with an override for the awkward
-- cases", and it is the wrong one: the override becomes the path and the evidence trail records
-- nothing. Instead every station has to be DECIDED - cleared, or waived with a written reason -
-- and a waiver is itself the override, recorded per station with an author and a timestamp. So the
-- gate has no back door and the audit trail is complete either way. phx_hr_clearance_release
-- enforces it in the database rather than in the service, because a settlement is money.
--
-- WHAT THIS DOES NOT DO: it never writes payroll. Both job descriptions name "may not approve final
-- settlement" as a boundary, and HR_ROLE_BOUNDARIES holds payroll:create/update/approve away from
-- both seats. `settlement_released_at` is HR RECORDING that the settlement went out, gated on the
-- evidence being complete. It is an observation with a precondition, not an approval.
--
-- NOT BACKFILLED, deliberately. The 54 existing resignations are all `completed` and most are
-- months old; opening a checklist for each would create 378 pending items that no one will ever
-- action and that would bury the live ones. Clearance starts from the next resignation. HR can
-- open one for an older departure by hand if the trail is needed.

begin;

-- ---------------------------------------------------------------------------
-- 1. CLEARANCE - the station catalogue
-- ---------------------------------------------------------------------------

create table if not exists public.hr_clearance_stations (
  id uuid primary key default gen_random_uuid(),
  -- Stable machine key. Referenced by hr_clearance_items.station_key, so it survives a relabel:
  -- renaming "Stores & Samples" to "Warehouse" must not orphan five years of cleared checklists.
  station_key text not null unique check (station_key ~ '^[a-z][a-z0-9_]*$'),
  label text not null check (char_length(label) between 2 and 80),
  -- What the person signing this station is actually confirming. Shown on the checklist row, so
  -- the station owner does not have to remember what "Admin" covers.
  description text,
  -- Who to chase. Free text on purpose: the holder of a station is a person or a desk, and this
  -- company has no department column to point at (see the header).
  responsible text,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_hr_clearance_stations_active
  on public.hr_clearance_stations (is_active, sort_order);

-- Seed. Seven stations that match how a field-force pharmaceutical company actually hands over.
-- `on conflict do nothing` so re-running this migration never resurrects a station the owner
-- deactivated or relabelled.
insert into public.hr_clearance_stations (station_key, label, description, responsible, sort_order)
values
  ('line_manager', 'Line Manager Handover',
   'Work, customers and pending tasks handed over; territory and open commitments confirmed.',
   'Direct manager', 10),
  ('it', 'IT & System Access',
   'Laptop, phone and SIM returned; email, Phoenix and all system access revoked.',
   'IT', 20),
  ('fleet', 'Fleet & Transport',
   'Company car, keys, fuel card and toll tag returned; traffic fines settled.',
   'Fleet / Admin', 30),
  ('stores', 'Stores, Samples & Promotional Materials',
   'Medical samples, giveaways, printed materials and any stock on hand returned or accounted for.',
   'Stores', 40),
  ('finance', 'Finance Settlement',
   'Outstanding advances, loans, petty cash and unsettled expense claims closed.',
   'Finance', 50),
  ('hr_records', 'HR Records & Insurance',
   'Company ID returned; medical and social insurance closure recorded; personnel file completed.',
   'HR Operations', 60),
  ('admin_security', 'Admin & Building Access',
   'Building access card, keys, locker and uniform returned.',
   'Admin / Security', 70)
on conflict (station_key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. CLEARANCE - one checklist per departure
-- ---------------------------------------------------------------------------

create table if not exists public.hr_clearance_checklists (
  id uuid primary key default gen_random_uuid(),
  -- One checklist per resignation. `on delete cascade` is safe here and nowhere else in this
  -- migration: a clearance trail for a resignation that no longer exists is not a record, it is
  -- an orphan. Deleting a resignation is Super Admin only (resignations:delete is a named JD
  -- boundary for both HR seats).
  resignation_id uuid not null unique references public.employee_resignations (id) on delete cascade,
  -- Snapshots, not joins. A leaver is `employment_status = 'resigned'` and drops out of the
  -- employee directory, so a checklist that resolved the name by join would render blank for
  -- exactly the people it is about.
  employee_hr_id text not null,
  employee_name text not null,
  job_title text,
  line_name text,
  last_working_date date,
  -- open      - at least one station still pending or blocked
  -- ready     - every station decided (cleared or waived); settlement may be released
  -- released  - HR recorded that the final settlement went out
  -- cancelled - the resignation itself was cancelled
  -- Stored rather than derived so the list view can filter and index on it. Kept true by
  -- phx_hr_clearance_refresh_status, which is the only thing that writes it.
  status text not null default 'open' check (status in ('open', 'ready', 'released', 'cancelled')),
  opened_at timestamptz not null default now(),
  opened_by text,
  ready_at timestamptz,
  settlement_released_at timestamptz,
  settlement_released_by text,
  settlement_note text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_hr_clearance_checklists_status
  on public.hr_clearance_checklists (status, last_working_date desc);
create index if not exists idx_hr_clearance_checklists_employee
  on public.hr_clearance_checklists (employee_hr_id);

create table if not exists public.hr_clearance_items (
  id uuid primary key default gen_random_uuid(),
  checklist_id uuid not null references public.hr_clearance_checklists (id) on delete cascade,
  -- Not a foreign key to hr_clearance_stations, on purpose. A station may be deactivated after a
  -- checklist has used it, and the cleared row must keep saying which station cleared it. The
  -- label is snapshotted for the same reason.
  station_key text not null,
  station_label text not null,
  sort_order integer not null default 100,
  -- pending - nobody has decided
  -- cleared - the station confirms nothing is outstanding
  -- blocked - something IS outstanding; reason required, amount optional
  -- waived  - the station does not apply to this person; reason required
  status text not null default 'pending' check (status in ('pending', 'cleared', 'blocked', 'waived')),
  -- Required for blocked and waived. Enforced below rather than left to the UI: the whole value of
  -- this module is that "why" survives, and a nullable reason column collects nulls.
  reason text,
  -- What the person still owes, when the station is blocked on money (an advance, a fine, stock).
  -- Informational - nothing here reaches payroll.
  amount_due numeric(12, 2) check (amount_due is null or amount_due >= 0),
  evidence_note text,
  decided_at timestamptz,
  decided_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (checklist_id, station_key),
  constraint hr_clearance_items_reason_required check (
    status not in ('blocked', 'waived') or (reason is not null and char_length(btrim(reason)) > 0)
  ),
  constraint hr_clearance_items_decided_stamped check (
    status = 'pending' or (decided_at is not null and decided_by is not null)
  )
);

create index if not exists idx_hr_clearance_items_checklist
  on public.hr_clearance_items (checklist_id, sort_order);
create index if not exists idx_hr_clearance_items_status
  on public.hr_clearance_items (status);

-- ---------------------------------------------------------------------------
-- 3. CLEARANCE - the functions that keep the gate honest
-- ---------------------------------------------------------------------------

-- Recompute a checklist's status from its items. The ONLY writer of `status` and `ready_at`.
-- Never moves a checklist out of `released` or `cancelled`: those are decisions, not derivations.
create or replace function public.phx_hr_clearance_refresh_status(p_checklist_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_current    text;
  v_undecided  integer;
  v_next       text;
begin
  select status into v_current
  from public.hr_clearance_checklists
  where id = p_checklist_id
  for update;

  if v_current is null then
    raise exception 'Clearance checklist % does not exist.', p_checklist_id;
  end if;

  if v_current in ('released', 'cancelled') then
    return v_current;
  end if;

  select count(*) into v_undecided
  from public.hr_clearance_items
  where checklist_id = p_checklist_id
    and status in ('pending', 'blocked');

  v_next := case when v_undecided = 0 then 'ready' else 'open' end;

  update public.hr_clearance_checklists
  set status = v_next,
      -- Stamped the first time it becomes ready and cleared if it falls back, so "ready since"
      -- always means the current stretch rather than the first time it ever qualified.
      ready_at = case when v_next = 'ready' then coalesce(ready_at, now()) else null end,
      updated_at = now()
  where id = p_checklist_id;

  return v_next;
end;
$fn$;

-- Create the checklist for a resignation if it has none, and add an item for every ACTIVE station
-- the checklist is missing. Idempotent, so it is safe to call on every read: a station added after
-- a departure still reaches the open checklists that need it.
create or replace function public.phx_hr_clearance_open(p_resignation_id uuid, p_actor text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_checklist_id uuid;
  v_res          record;
begin
  select r.id, r.employee_hr_id, r.employee_name, r.job_title, r.line_name, r.last_working_date
    into v_res
  from public.employee_resignations r
  where r.id = p_resignation_id;

  if v_res.id is null then
    raise exception 'Resignation % does not exist.', p_resignation_id;
  end if;

  insert into public.hr_clearance_checklists (
    resignation_id, employee_hr_id, employee_name, job_title, line_name, last_working_date, opened_by
  )
  values (
    v_res.id, v_res.employee_hr_id, v_res.employee_name, v_res.job_title, v_res.line_name,
    v_res.last_working_date, p_actor
  )
  on conflict (resignation_id) do nothing;

  select id into v_checklist_id
  from public.hr_clearance_checklists
  where resignation_id = p_resignation_id;

  -- Every active station this checklist does not already carry. `on conflict do nothing` covers
  -- the concurrent case and keeps a decided item from being reset to pending.
  insert into public.hr_clearance_items (checklist_id, station_key, station_label, sort_order)
  select v_checklist_id, s.station_key, s.label, s.sort_order
  from public.hr_clearance_stations s
  where s.is_active = true
  on conflict (checklist_id, station_key) do nothing;

  perform public.phx_hr_clearance_refresh_status(v_checklist_id);

  return v_checklist_id;
end;
$fn$;

-- Decide one station. Rejects a blocked/waived decision with no reason at the database level, so
-- an empty reason cannot arrive from a client that skipped the form validation.
create or replace function public.phx_hr_clearance_decide(
  p_item_id uuid,
  p_status text,
  p_actor text,
  p_reason text default null,
  p_evidence_note text default null,
  p_amount_due numeric default null
)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_checklist_id uuid;
  v_checklist    text;
begin
  if p_status not in ('pending', 'cleared', 'blocked', 'waived') then
    raise exception 'Unknown clearance status "%".', p_status;
  end if;

  if p_status in ('blocked', 'waived') and coalesce(btrim(p_reason), '') = '' then
    raise exception 'A % decision needs a written reason.', p_status;
  end if;

  select i.checklist_id, c.status into v_checklist_id, v_checklist
  from public.hr_clearance_items i
  join public.hr_clearance_checklists c on c.id = i.checklist_id
  where i.id = p_item_id;

  if v_checklist_id is null then
    raise exception 'Clearance item % does not exist.', p_item_id;
  end if;

  -- A released checklist is the evidence behind a settlement that has already gone out. Editing it
  -- afterwards would rewrite the record the release was justified by.
  if v_checklist in ('released', 'cancelled') then
    raise exception 'This clearance is % and can no longer be edited.', v_checklist;
  end if;

  update public.hr_clearance_items
  set status = p_status,
      reason = case when p_status in ('blocked', 'waived') then btrim(p_reason) else null end,
      evidence_note = p_evidence_note,
      amount_due = case when p_status = 'blocked' then p_amount_due else null end,
      decided_at = case when p_status = 'pending' then null else now() end,
      decided_by = case when p_status = 'pending' then null else p_actor end,
      updated_at = now()
  where id = p_item_id;

  return public.phx_hr_clearance_refresh_status(v_checklist_id);
end;
$fn$;

-- Record that the final settlement was released. THE GATE. Refuses unless every station is
-- decided, and says which ones are not - a refusal a person can act on beats a boolean.
create or replace function public.phx_hr_clearance_release(
  p_checklist_id uuid,
  p_actor text,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_status     text;
  v_undecided  text;
begin
  -- Recompute first: never gate on a stored status that a concurrent decision has just moved.
  v_status := public.phx_hr_clearance_refresh_status(p_checklist_id);

  if v_status = 'released' then
    raise exception 'This settlement was already recorded as released.';
  end if;

  if v_status = 'cancelled' then
    raise exception 'This clearance was cancelled and cannot be released.';
  end if;

  if v_status <> 'ready' then
    select string_agg(station_label, ', ' order by sort_order) into v_undecided
    from public.hr_clearance_items
    where checklist_id = p_checklist_id
      and status in ('pending', 'blocked');

    raise exception 'Clearance is not complete - still outstanding: %. Clear each station, or waive it with a reason.', coalesce(v_undecided, 'unknown');
  end if;

  update public.hr_clearance_checklists
  set status = 'released',
      settlement_released_at = now(),
      settlement_released_by = p_actor,
      settlement_note = p_note,
      updated_at = now()
  where id = p_checklist_id;
end;
$fn$;

-- Open the checklist the moment a resignation is recorded, so the trail cannot be forgotten.
-- AFTER INSERT, and deliberately not BEFORE: the checklist snapshots the resignation's own values.
create or replace function public.phx_hr_clearance_on_resignation()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- Best-effort. A clearance checklist must never be the reason a resignation fails to record:
  -- the departure is the fact, the checklist is the follow-up, and HR can open one by hand.
  begin
    perform public.phx_hr_clearance_open(new.id, new.created_by);
  exception when others then
    raise warning 'Could not open a clearance checklist for resignation %: %', new.id, sqlerrm;
  end;
  return new;
end;
$fn$;

drop trigger if exists trg_hr_clearance_on_resignation on public.employee_resignations;
create trigger trg_hr_clearance_on_resignation
after insert on public.employee_resignations
for each row execute function public.phx_hr_clearance_on_resignation();

-- ---------------------------------------------------------------------------
-- 4. RETENTION - stay discussions and exit interviews, summarised into themes
-- ---------------------------------------------------------------------------

create table if not exists public.hr_retention_themes (
  id uuid primary key default gen_random_uuid(),
  theme_key text not null unique check (theme_key ~ '^[a-z][a-z0-9_]*$'),
  label text not null check (char_length(label) between 2 and 60),
  description text,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_hr_retention_themes_active
  on public.hr_retention_themes (is_active, sort_order);

insert into public.hr_retention_themes (theme_key, label, description, sort_order)
values
  ('compensation',   'Pay & Benefits',            'Salary, incentive, allowances, medical cover.', 10),
  ('manager',        'Relationship With Manager', 'Direct manager support, fairness, communication.', 20),
  ('career_growth',  'Career Path & Growth',      'Promotion, next step, feeling stuck.', 30),
  ('workload',       'Workload & Hours',          'Volume of work, targets, travel days, work-life balance.', 40),
  ('recognition',    'Recognition & Feedback',    'Being seen, appreciated and told where they stand.', 50),
  ('commute',        'Commute & Territory',       'Distance, territory shape, time on the road.', 60),
  ('team',           'Team & Culture',            'Colleagues, belonging, how the team works together.', 70),
  ('tools',          'Tools & Systems',           'Equipment, systems and materials needed to do the job.', 80),
  ('job_security',   'Stability & Job Security',  'Confidence in the company and in the role.', 90),
  ('external_offer', 'External Offer',            'A specific offer elsewhere, and what made it attractive.', 100),
  ('training',       'Training & Development',    'Onboarding, product knowledge, skills support.', 110),
  ('personal',       'Personal & Family',         'Health, family, relocation, study - reasons outside work.', 120)
on conflict (theme_key) do nothing;

create table if not exists public.hr_retention_conversations (
  id uuid primary key default gen_random_uuid(),
  -- stay - held with someone still employed, to understand what keeps them and what would not
  -- exit - held with someone leaving
  kind text not null check (kind in ('stay', 'exit')),
  -- Snapshots for the same reason the clearance checklist snapshots: an exit interview is about
  -- someone who has left the directory by the time anyone reads the roll-up.
  employee_hr_id text not null,
  employee_name text not null,
  job_title text,
  line_name text,
  conducted_on date not null,
  conducted_by text,
  -- Present for an exit conversation, null for a stay one. Not a required link: an exit interview
  -- can be held for a departure recorded outside the resignation flow.
  resignation_id uuid references public.employee_resignations (id) on delete set null,
  -- STAY only. How likely this person is to leave, in the interviewer's judgement.
  retention_risk text check (retention_risk is null or retention_risk in ('low', 'medium', 'high')),
  -- EXIT only. `is_regrettable` is the number that matters to a business: losing someone you
  -- wanted to keep is a different event from someone leaving whom you were not going to keep.
  is_regrettable boolean,
  would_rejoin boolean,
  summary text not null check (char_length(btrim(summary)) > 0),
  -- STAY conversations are worth nothing without follow-through, which is the half that usually
  -- gets dropped. Nullable, because not every conversation produces an action.
  follow_up_action text,
  follow_up_due date,
  follow_up_done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text,
  -- The two kind-specific fields are required for their own kind and forbidden for the other, so
  -- a roll-up can trust them. A stay conversation with `is_regrettable` set would silently join
  -- the turnover figures.
  constraint hr_retention_kind_fields check (
    (kind = 'stay' and retention_risk is not null and is_regrettable is null and would_rejoin is null)
    or
    (kind = 'exit' and retention_risk is null and is_regrettable is not null)
  )
);

create index if not exists idx_hr_retention_conversations_kind
  on public.hr_retention_conversations (kind, conducted_on desc);
create index if not exists idx_hr_retention_conversations_employee
  on public.hr_retention_conversations (employee_hr_id, conducted_on desc);
create index if not exists idx_hr_retention_conversations_followup
  on public.hr_retention_conversations (follow_up_due)
  where follow_up_action is not null and follow_up_done_at is null;

-- "Summarised into themes" - the JD phrase this table exists to satisfy. A conversation carries
-- several, each as a DRIVER (what holds someone, or what was good) or a BLOCKER (what pushed them
-- out, or what would). One theme can legitimately be both: pay can be the reason someone stays
-- and the reason they nearly did not.
create table if not exists public.hr_retention_conversation_themes (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.hr_retention_conversations (id) on delete cascade,
  theme_key text not null,
  sentiment text not null check (sentiment in ('driver', 'blocker')),
  note text,
  created_at timestamptz not null default now(),
  unique (conversation_id, theme_key, sentiment)
);

create index if not exists idx_hr_retention_conv_themes_theme
  on public.hr_retention_conversation_themes (theme_key, sentiment);
create index if not exists idx_hr_retention_conv_themes_conversation
  on public.hr_retention_conversation_themes (conversation_id);

-- ---------------------------------------------------------------------------
-- 5. RLS
--
-- Visibility in this app is application-scoped: nearly every read goes through the service-role
-- client, and access is decided by assertPermission in the route handler. RLS is enabled with no
-- permissive policy so that anon and authenticated reach nothing directly - the same posture the
-- mailbox monitor tables take. Retention conversations in particular hold what an employee said
-- in confidence about their manager and their pay.
-- ---------------------------------------------------------------------------

alter table public.hr_clearance_stations enable row level security;
alter table public.hr_clearance_checklists enable row level security;
alter table public.hr_clearance_items enable row level security;
alter table public.hr_retention_themes enable row level security;
alter table public.hr_retention_conversations enable row level security;
alter table public.hr_retention_conversation_themes enable row level security;

notify pgrst, 'reload schema';

commit;
