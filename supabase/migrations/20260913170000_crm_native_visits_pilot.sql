-- Native visits — the PILOT (CRM phase 3).
--
-- WHAT THIS IS. Phoenix's own visit record, written by the rep on his phone, for ONE line for ONE
-- week (owner decision 17). Everyone else — and the pilot line too — keeps entering visits in
-- iReports360, and the vendor mirror stays the only source every report, KPI, deduction, probation
-- count and payroll input reads. Nothing in this migration touches an ireports360_* table (owner
-- decision 19) and no consumer reads these tables: a native row reaching a consumer before cutover
-- would double-count a visit that also exists in the vendor feed.
--
-- WHAT IS HERE.
--   crm_native_visit_pilots   which line is piloting, and from when to when. A setting, not code:
--                             seeded with Pedia, Saturday 19 – Thursday 24 September 2026.
--   crm_native_visits         one row per visit or non-visit half-day, per audit §11.1:
--                             · the rep (a real FK to employees) and a SNAPSHOT of who he was that
--                               day — title, app role, line, area, region, seat, direct manager;
--                             · the visit day (Cairo) and AM/PM, both required;
--                             · an explicit type, each mapped to the vendor's legacy code by a check
--                               constraint — no comment parsing, and -4 stays the only leave;
--                             · a contact from the contact master with its grade, speciality and list
--                               as they were, or a named prospect on a campaign visit. The catch-all
--                               contact 100000 is refused;
--                             · GPS with accuracy and address. A missing fix is a FLAG, never a
--                               refusal (owner decision 7);
--                             · the device clock and the server clock, both true UTC (vendor rows are
--                               Cairo-as-UTC; a cutover must convert, never compare raw);
--                             · client_submission_id, so an offline queue that sends twice saves once;
--                             · a soft delete with who, when and why.
--   crm_native_visit_partners one row per person the rep says accompanied him, with that person's
--                             role at the time, whether he is the rep's direct manager, and whether he
--                             has confirmed. The rep records it; the partner decides (owner decision
--                             10). A row is only ever decided by the partner's own click.
--   crm_native_visit_events   append-only history: created, deleted, confirmed, rejected.
--
-- ONE VISIT PER REP, CONTACT AND DAY is a unique index, so a second save is refused by the database
-- itself and not only by the form.
--
-- PURELY ADDITIVE. RLS on, nothing granted to anon or authenticated; every read and write goes
-- through the service-role client behind the app's own permission and scope checks.

begin;

create table if not exists public.crm_native_visit_pilots (
  line_name text primary key,
  starts_on date not null,
  ends_on date not null,
  is_active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint crm_native_visit_pilots_period check (ends_on >= starts_on),
  constraint crm_native_visit_pilots_line_name check (btrim(line_name) <> '')
);

comment on table public.crm_native_visit_pilots is
  'Which line enters visits natively in Phoenix, and for which dates. Pilot only: native visits reach no pay, deduction, probation or KPI screen until the cutover.';

insert into public.crm_native_visit_pilots (line_name, starts_on, ends_on, is_active, note, updated_by)
values (
  'Pedia',
  date '2026-09-19',
  date '2026-09-24',
  true,
  'One-week pilot (owner decision 17). iReports360 stays the source for everyone, including this line.',
  'migration'
)
on conflict (line_name) do nothing;

create table if not exists public.crm_native_visits (
  id uuid primary key default gen_random_uuid(),
  client_submission_id uuid not null,
  hr_id text not null references public.employees (hr_id),
  job_title text,
  app_role text not null,
  line_name text not null,
  area_name text,
  region_name text,
  seat_id text,
  manager_hr_id text,
  visit_date date not null,
  shift text not null,
  visit_type text not null,
  legacy_visit_type integer not null,
  contact_crm_id bigint references public.crm_contacts (contact_crm_id),
  contact_name text,
  contact_speciality text,
  contact_grade text,
  contact_list_type text,
  prospect_name text,
  prospect_speciality text,
  latitude double precision,
  longitude double precision,
  gps_accuracy_m double precision,
  gps_address text,
  gps_status text not null,
  comment text,
  plan_item_id text,
  device_recorded_at timestamptz not null,
  server_received_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by text,
  delete_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_native_visits_client_submission_uidx unique (client_submission_id),
  constraint crm_native_visits_shift check (shift in ('AM', 'PM')),
  constraint crm_native_visits_type check (
    visit_type in (
      'regular', 'campaign', 'conference', 'group_meeting', 'annual_vacation', 'public_holiday',
      'casual_leave', 'training', 'meeting', 'traveling', 'health_day', 'admin_work', 'business_review'
    )
  ),
  -- The ONE mapping to the vendor's code. src/lib/crm/native-visits/rules.ts carries the same table
  -- and tests/crm-native-visits.test.ts holds the two in step and against visit-type-meaning.ts.
  constraint crm_native_visits_legacy_code check (
    legacy_visit_type = case visit_type
      when 'regular' then 0
      when 'campaign' then -8
      when 'conference' then -1
      when 'group_meeting' then -2
      when 'annual_vacation' then -4
      when 'public_holiday' then -5
      when 'casual_leave' then -6
      when 'training' then -9
      when 'meeting' then -11
      when 'traveling' then -12
      when 'health_day' then -15
      when 'admin_work' then -20
      when 'business_review' then -21
    end
  ),
  constraint crm_native_visits_contact_rule check (
    case
      when visit_type = 'regular' then contact_crm_id is not null and prospect_name is null
      when visit_type = 'campaign' then (contact_crm_id is not null) <> (prospect_name is not null)
      else contact_crm_id is null and prospect_name is null
    end
  ),
  constraint crm_native_visits_real_contact check (contact_crm_id is null or contact_crm_id <> 100000),
  constraint crm_native_visits_coordinates_pair check ((latitude is null) = (longitude is null)),
  constraint crm_native_visits_gps_status check (
    gps_status in ('captured', 'missing', 'out_of_bounds') and (gps_status = 'missing') = (latitude is null)
  ),
  constraint crm_native_visits_soft_delete check (
    (deleted_at is null) = (deleted_by is null) and (deleted_at is null) = (delete_reason is null)
  )
);

comment on table public.crm_native_visits is
  'Native (Phoenix-entered) visits — PILOT. Read by nothing but the native-visits module until the cutover; the ireports360 mirror stays the source of every report, KPI and pay input.';

-- One visit per rep, contact and day, refused at save.
create unique index if not exists crm_native_visits_one_per_contact_day_uidx
  on public.crm_native_visits (hr_id, contact_crm_id, visit_date)
  where deleted_at is null and contact_crm_id is not null;

-- An annual-vacation half-day is recorded once.
create unique index if not exists crm_native_visits_one_leave_per_shift_uidx
  on public.crm_native_visits (hr_id, visit_date, shift)
  where deleted_at is null and visit_type = 'annual_vacation';

create index if not exists crm_native_visits_rep_day_idx
  on public.crm_native_visits (hr_id, visit_date);

create index if not exists crm_native_visits_line_day_idx
  on public.crm_native_visits (line_name, visit_date)
  where deleted_at is null;

create table if not exists public.crm_native_visit_partners (
  id bigint generated always as identity primary key,
  visit_id uuid not null references public.crm_native_visits (id) on delete restrict,
  partner_hr_id text not null references public.employees (hr_id),
  partner_name text,
  partner_job_title text,
  partner_app_role text,
  is_direct_manager boolean not null,
  status text not null default 'pending',
  decided_at timestamptz,
  decided_by text,
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_native_visit_partners_once unique (visit_id, partner_hr_id),
  constraint crm_native_visit_partners_status check (status in ('pending', 'confirmed', 'rejected')),
  -- A decision is a person's click: it always carries who and when, and only the partner decides.
  constraint crm_native_visit_partners_decision check (
    case
      when status = 'pending' then decided_at is null and decided_by is null
      else decided_at is not null and decided_by is not null and decided_by = partner_hr_id
    end
  )
);

comment on table public.crm_native_visit_partners is
  'Who the rep says accompanied a native visit, and that person''s own confirmation. Never decided by the system.';

create index if not exists crm_native_visit_partners_pending_idx
  on public.crm_native_visit_partners (partner_hr_id)
  where status = 'pending';

create table if not exists public.crm_native_visit_events (
  id bigint generated always as identity primary key,
  visit_id uuid not null references public.crm_native_visits (id) on delete restrict,
  event text not null,
  actor_hr_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint crm_native_visit_events_event check (
    event in ('created', 'deleted', 'partner_confirmed', 'partner_rejected')
  )
);

comment on table public.crm_native_visit_events is
  'Append-only history of every native visit: created, deleted, partner confirmed or rejected.';

create index if not exists crm_native_visit_events_visit_idx
  on public.crm_native_visit_events (visit_id, created_at);

alter table public.crm_native_visit_pilots enable row level security;
alter table public.crm_native_visits enable row level security;
alter table public.crm_native_visit_partners enable row level security;
alter table public.crm_native_visit_events enable row level security;

revoke all on table public.crm_native_visit_pilots from anon, authenticated;
revoke all on table public.crm_native_visits from anon, authenticated;
revoke all on table public.crm_native_visit_partners from anon, authenticated;
revoke all on table public.crm_native_visit_events from anon, authenticated;
revoke all on sequence public.crm_native_visit_partners_id_seq from anon, authenticated;
revoke all on sequence public.crm_native_visit_events_id_seq from anon, authenticated;

commit;

-- ROLLBACK. Safe only while no rep has entered a real visit (check `select count(*) from
-- public.crm_native_visits` first — a pilot visit is evidence, and production has no PITR):
--   begin;
--   drop table if exists public.crm_native_visit_events;
--   drop table if exists public.crm_native_visit_partners;
--   drop table if exists public.crm_native_visits;
--   drop table if exists public.crm_native_visit_pilots;
--   commit;
-- To END the pilot without losing anything, set is_active = false on its row instead.
