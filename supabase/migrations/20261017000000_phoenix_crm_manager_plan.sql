-- phoenix_crm_manager_plan
--
-- WHAT THIS CHANGES:
--   1. Seven new tables — the district manager's weekly plan in Phoenix CRM and what he logs against it:
--        phoenix_crm_manager_plans               one week of one district manager: its status, version,
--                                                due date, approvers and decisions
--        phoenix_crm_manager_plan_slots          one half-day of that week (AM or PM) and what he does
--                                                in it: with a rep, admin, or a single visit in an area
--        phoenix_crm_manager_plan_customers      the customers he ticked for a half-day
--        phoenix_crm_manager_plan_events         every send, decision, return and reopening, with a copy
--                                                of what was sent
--        phoenix_crm_manager_plan_edit_requests  his ask to edit a sent week, decided by his approver
--        phoenix_crm_manager_customers           "Manager's own list" — the customers he adds himself
--        phoenix_crm_manager_visits              the single visits he logs himself, planned or not
--   2. Seven new functions, every one SECURITY DEFINER and executable by service_role alone:
--        phoenix_crm_save_manager_plan_slot              sets, changes or clears ONE half-day
--        phoenix_crm_manager_plan_transition             send, approve (first, second, Administrator), return
--        phoenix_crm_raise_manager_plan_edit             his ask to edit a sent week
--        phoenix_crm_decide_manager_plan_edit            reopen or refuse that ask
--        phoenix_crm_expire_manager_plan_edit_requests   an ask nobody answered before its week ended
--        phoenix_crm_request_manager_customer_removal    his ask to take a customer off his own list
--        phoenix_crm_decide_manager_customer_removal     that ask, approved or refused above him
--   3. phoenix_crm_merge_duplicate_customer — its live body (20261008120000; production md5(prosrc)
--      0a599fe2300702ad19faac32b0c3ece6, the file's text with its comments stripped on apply) with ONE
--      change: a merged-away customer's rows in the two new tables that name a rep's customer follow it
--      to the row that stays, as every other child table already does. A day on which the manager logged
--      both rows refuses, the way a rep's visit on both does.
--
-- WHY (owner, 2026-10-16):
--   "The weekly plan for the managers. Let's start with the district sales manager … exactly like the
--   numbered form that the medical reps use … instead of the doctors, the medical reps appear, and the
--   bricks they are going to today." For each half-day the district manager picks a rep and ticks that
--   rep's own customers for it, or picks Admin (the seven day activities), or a Single visit in an area
--   of his district. It REPLACES his legacy Weekly/Monthly plan once his team is live, is due Thursday
--   23:55 Cairo like his reps', and is approved by his RSM/NSM in the Approvals Hub — Hany Saad's
--   district managers go on to Ali Mohamed Ali. The Administrator may act in the holder's place.
--
--   🔴 THE REP NEVER SEES IT, AND NOTHING HERE COUNTS IN A KPI. Ticking a rep is not a double visit — the
--   double visit is the one the REP logs naming him (phoenix_crm_report_manager_visits). His own single
--   visits count in his own report and nowhere else: no countable-visits view, no coverage, no call
--   rate, no frequency and no target reads phoenix_crm_manager_visits. These are new tables so that every
--   reader of phoenix_crm_plans (which a rep seat owns) stays exactly as it is.
--
--   Every function trusts the application for WHO acts — it proves the actor and passes the approvers
--   in, as every Phoenix CRM function does. The database keeps the calendar (the Cairo day, the field
--   week, its two halves, the deadline), the state machine, and which world (is_test) a row lives in.
--
-- ROLLBACK:
--   drop function if exists public.phoenix_crm_save_manager_plan_slot(jsonb);
--   drop function if exists public.phoenix_crm_manager_plan_transition(jsonb);
--   drop function if exists public.phoenix_crm_raise_manager_plan_edit(jsonb);
--   drop function if exists public.phoenix_crm_decide_manager_plan_edit(jsonb);
--   drop function if exists public.phoenix_crm_expire_manager_plan_edit_requests(jsonb);
--   drop function if exists public.phoenix_crm_request_manager_customer_removal(jsonb);
--   drop function if exists public.phoenix_crm_decide_manager_customer_removal(jsonb);
--   re-apply phoenix_crm_merge_duplicate_customer from 20261008120000 (BEFORE the tables go, since this
--   body names them); then drop the seven tables, children first:
--   drop table if exists public.phoenix_crm_manager_visits, public.phoenix_crm_manager_plan_customers,
--     public.phoenix_crm_manager_plan_events, public.phoenix_crm_manager_plan_edit_requests,
--     public.phoenix_crm_manager_plan_slots, public.phoenix_crm_manager_customers,
--     public.phoenix_crm_manager_plans;
--   -- SAFE: rollback only. DATA COST: every manager plan, own-list customer and manager visit since it went live.
--
-- Verification after apply:
--   select relname, relrowsecurity from pg_class where relname like 'phoenix_crm_manager_%' and relkind = 'r';  -- 7 rows, all t
--   select proname, prosecdef from pg_proc where proname like 'phoenix_crm_%manager_%';                          -- all t
--   select has_function_privilege('anon', 'public.phoenix_crm_manager_plan_transition(jsonb)', 'execute');      -- f
--   select has_table_privilege('authenticated', 'public.phoenix_crm_manager_plans', 'select');                  -- f
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration adds seven empty tables and seven functions and replaces one function body; no existing
-- row is touched.

begin;
set local lock_timeout = '5s';

-- ── 1. The week ─────────────────────────────────────────────────────────────────────────────────

create table if not exists public.phoenix_crm_manager_plans (
  id uuid primary key default gen_random_uuid(),
  -- The district manager whose week this is, and the DM or ACTING_DM seat he plans it from.
  manager_hr_id text not null,
  manager_seat_id text not null,
  line_code text,
  week_start date not null,
  status text not null default 'draft',
  version integer not null default 1,
  due_on date not null,
  submitted_at timestamptz,
  submitted_by_hr_id text,
  submitted_late boolean,
  -- Who approves it, fixed on every send: his RSM/NSM, and for Hany Saad's district managers Ali.
  first_approver_hr_id text,
  second_approver_hr_id text,
  first_decided_at timestamptz,
  first_decided_by_hr_id text,
  first_decided_role text,
  first_decision_note text,
  -- The final decision: the approval that closed it, or the return that sent it back.
  decided_at timestamptz,
  decided_by_hr_id text,
  decided_by_role text,
  decision_note text,
  returned_day date,
  returned_stage text,
  created_by_hr_id text not null,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_manager_plans_status check (status in ('draft', 'submitted', 'first_approved', 'approved', 'returned')),
  constraint phoenix_crm_manager_plans_saturday check (extract(isodow from week_start) = 6),
  constraint phoenix_crm_manager_plans_version check (version >= 1),
  constraint phoenix_crm_manager_plans_sent_has_approver check (status = 'draft' or first_approver_hr_id is not null),
  constraint phoenix_crm_manager_plans_returned_day check (
    returned_day is null or (status = 'returned' and returned_day between week_start and week_start + 5)
  ),
  constraint phoenix_crm_manager_plans_returned_stage check (
    returned_stage is null or (status = 'returned' and returned_stage in ('first', 'second'))
  ),
  constraint phoenix_crm_manager_plans_roles check (
    (first_decided_role is null or first_decided_role in ('first', 'administrator'))
    and (decided_by_role is null or decided_by_role in ('first', 'second', 'administrator'))
  ),
  constraint phoenix_crm_manager_plans_notes check (
    char_length(coalesce(first_decision_note, '')) <= 500 and char_length(coalesce(decision_note, '')) <= 500
  ),
  constraint phoenix_crm_manager_plans_upper check (
    manager_hr_id = upper(manager_hr_id)
    and created_by_hr_id = upper(created_by_hr_id)
    and coalesce(first_approver_hr_id, '') = upper(coalesce(first_approver_hr_id, ''))
    and coalesce(second_approver_hr_id, '') = upper(coalesce(second_approver_hr_id, ''))
    and first_approver_hr_id is distinct from manager_hr_id
    and second_approver_hr_id is distinct from manager_hr_id
  )
);

comment on table public.phoenix_crm_manager_plans is
  'The district manager''s weekly plan in Phoenix CRM (owner, 2026-10-16): one row per manager, field week and world. Approved by his RSM/NSM in the Approvals Hub (Hany Saad''s district managers then by Ali Mohamed Ali); the Administrator may act in place of the holder. The rep never sees it, and nothing in it counts in a KPI.';

create unique index if not exists phoenix_crm_manager_plans_week_uniq
  on public.phoenix_crm_manager_plans (manager_hr_id, week_start, is_test);
-- The target of the slots' composite key, so a half-day can never sit in another week's plan.
create unique index if not exists phoenix_crm_manager_plans_id_week_uniq
  on public.phoenix_crm_manager_plans (id, week_start);
create index if not exists phoenix_crm_manager_plans_first_idx
  on public.phoenix_crm_manager_plans (first_approver_hr_id, status, is_test);
create index if not exists phoenix_crm_manager_plans_second_idx
  on public.phoenix_crm_manager_plans (second_approver_hr_id, status, is_test);
create index if not exists phoenix_crm_manager_plans_week_idx
  on public.phoenix_crm_manager_plans (week_start, is_test);

-- ── 2. Manager's own list ──────────────────────────────────────────────────────────────────────

create table if not exists public.phoenix_crm_manager_customers (
  id uuid primary key default gen_random_uuid(),
  manager_hr_id text not null,
  line_code text,
  name text not null,
  speciality text,
  phone text,
  contact_note text,
  -- His grade, never validated (owner, 2026-10-16: "there will not be validation because they are managers").
  grade text not null,
  potential_grade text not null,
  comment text,
  -- The area of his district he added the customer under.
  area_seat_id text,
  area_code text,
  area_name text,
  -- Capture location — optional (owner, 2026-10-16: "optional but available"). Address, governorate
  -- and brick are resolved on the server from the pin; a pin is all or nothing.
  pin_lat double precision,
  pin_lon double precision,
  pin_accuracy_meters numeric,
  pin_address text,
  pin_governorate text,
  pin_area_code text,
  pin_area_name text,
  pin_brick_id text,
  pin_brick_name text,
  pin_brick_distance_km numeric,
  pin_brick_lookup text,
  pinned_at timestamptz,
  status text not null default 'active',
  removal_reason text,
  removal_requested_at timestamptz,
  removal_requested_by_hr_id text,
  removal_approver_hr_id text,
  removal_decided_at timestamptz,
  removal_decided_by_hr_id text,
  removal_decided_role text,
  removal_decision_note text,
  created_by_hr_id text not null,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_manager_customers_name check (char_length(trim(name)) between 1 and 200),
  constraint phoenix_crm_manager_customers_speciality check (speciality is null or char_length(speciality) <= 120),
  constraint phoenix_crm_manager_customers_phone check (phone is null or phone ~ '^\+?[0-9]{7,15}$'),
  constraint phoenix_crm_manager_customers_contact_note check (contact_note is null or char_length(contact_note) <= 300),
  constraint phoenix_crm_manager_customers_grade check (grade in ('A', 'B', 'C')),
  constraint phoenix_crm_manager_customers_potential_grade check (potential_grade in ('AA', 'AB', 'AC', 'BA', 'BB', 'BC')),
  constraint phoenix_crm_manager_customers_comment check (comment is null or char_length(comment) <= 500),
  constraint phoenix_crm_manager_customers_pin check (
    (pin_lat is null) = (pin_lon is null)
    and (pin_lat is null) = (pin_brick_lookup is null)
    and (pin_lat is null) = (pinned_at is null)
    and (pin_lat is null or (pin_lat between 21.5 and 32 and pin_lon between 24 and 37.5))
    and (pin_brick_lookup is null or pin_brick_lookup in ('matched', 'none_nearby', 'could_not_look'))
    and (pin_accuracy_meters is null or pin_accuracy_meters >= 0)
  ),
  constraint phoenix_crm_manager_customers_status check (status in ('active', 'removal_pending', 'removed')),
  constraint phoenix_crm_manager_customers_removal check (
    (status = 'active' or (removal_reason is not null and removal_requested_at is not null and removal_approver_hr_id is not null))
    and (status <> 'removed' or removal_decided_at is not null)
    and (removal_reason is null or char_length(removal_reason) <= 500)
    and (removal_decision_note is null or char_length(removal_decision_note) <= 500)
    and (removal_decided_role is null or removal_decided_role in ('first', 'administrator'))
  ),
  constraint phoenix_crm_manager_customers_upper check (
    manager_hr_id = upper(manager_hr_id) and created_by_hr_id = upper(created_by_hr_id)
  )
);

comment on table public.phoenix_crm_manager_customers is
  'Manager''s own list (owner, 2026-10-16): the customers a district manager adds himself for his single visits, graded by him with no validation step. Never merged into his reps'' lists; taking one off needs his RSM/NSM''s approval. Nothing in it counts in a rep''s or the district''s coverage, call rate, frequency or target.';

create index if not exists phoenix_crm_manager_customers_manager_idx
  on public.phoenix_crm_manager_customers (manager_hr_id, is_test, status);
create index if not exists phoenix_crm_manager_customers_removal_idx
  on public.phoenix_crm_manager_customers (removal_approver_hr_id, status, is_test);
-- Namesakes are real, so the folded name is an index, never a unique key: a match is OFFERED, not forced.
create index if not exists phoenix_crm_manager_customers_fold_idx
  on public.phoenix_crm_manager_customers (manager_hr_id, (public.phoenix_crm_fold_name(name)));

-- ── 3. A half-day ──────────────────────────────────────────────────────────────────────────────

create table if not exists public.phoenix_crm_manager_plan_slots (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null,
  week_start date not null,
  plan_date date not null,
  half text not null,
  kind text not null,
  -- With a rep: the rep seat, and who held it when he planned it.
  rep_seat_id text,
  rep_hr_id text,
  -- Admin: one of the seven day activities.
  activity_type text,
  -- Single visit: the area of his district.
  area_seat_id text,
  area_code text,
  area_name text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_manager_plan_slots_plan_fk foreign key (plan_id, week_start)
    references public.phoenix_crm_manager_plans (id, week_start) on delete cascade,
  constraint phoenix_crm_manager_plan_slots_half check (half in ('AM', 'PM')),
  -- Saturday to Thursday of its own week (never a Friday, which is week_start + 6); Thursday a morning.
  constraint phoenix_crm_manager_plan_slots_in_week check (plan_date between week_start and week_start + 5),
  constraint phoenix_crm_manager_plan_slots_thursday_am check (not (extract(isodow from plan_date) = 4 and half = 'PM')),
  constraint phoenix_crm_manager_plan_slots_kind check (
    (kind = 'with_rep' and rep_seat_id is not null and rep_hr_id is not null and activity_type is null
      and area_code is null and area_seat_id is null)
    or (kind = 'admin' and activity_type in ('meeting', 'training', 'conference', 'admin_work', 'travel', 'health_day', 'sales_day')
      and rep_seat_id is null and rep_hr_id is null and area_code is null and area_seat_id is null)
    or (kind = 'single_visit' and area_code is not null and rep_seat_id is null and rep_hr_id is null and activity_type is null)
  ),
  constraint phoenix_crm_manager_plan_slots_note check (note is null or char_length(note) <= 500),
  constraint phoenix_crm_manager_plan_slots_upper check (rep_hr_id is null or rep_hr_id = upper(rep_hr_id))
);

comment on table public.phoenix_crm_manager_plan_slots is
  'One half-day of a district manager''s week (owner, 2026-10-16): with a rep (his seat and the customers ticked), admin (one of the seven day activities), or a single visit in an area of his district.';

create unique index if not exists phoenix_crm_manager_plan_slots_uniq
  on public.phoenix_crm_manager_plan_slots (plan_id, plan_date, half);
create index if not exists phoenix_crm_manager_plan_slots_plan_week_idx
  on public.phoenix_crm_manager_plan_slots (plan_id, week_start);
create index if not exists phoenix_crm_manager_plan_slots_rep_idx
  on public.phoenix_crm_manager_plan_slots (rep_seat_id, plan_date) where rep_seat_id is not null;

-- ── 4. The customers he ticked ─────────────────────────────────────────────────────────────────

create table if not exists public.phoenix_crm_manager_plan_customers (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references public.phoenix_crm_manager_plan_slots (id) on delete cascade,
  -- A customer on a rep's list, or one of his own — never both.
  customer_id uuid references public.phoenix_crm_customers (id),
  manager_customer_id uuid references public.phoenix_crm_manager_customers (id),
  -- The rep seat the customer sat on when he ticked it, and its list. No link to the rep's plan item:
  -- the rep's own save rewrites those rows, and "no longer on the rep's day" is worked out on reading.
  source_seat_id text,
  list_type text,
  created_at timestamptz not null default now(),
  constraint phoenix_crm_manager_plan_customers_one check ((customer_id is null) <> (manager_customer_id is null)),
  constraint phoenix_crm_manager_plan_customers_source check (customer_id is null or source_seat_id is not null),
  constraint phoenix_crm_manager_plan_customers_list_type check (list_type is null or list_type in ('AM', 'PM', 'Pharmacy'))
);

create unique index if not exists phoenix_crm_manager_plan_customers_customer_uniq
  on public.phoenix_crm_manager_plan_customers (slot_id, customer_id) where customer_id is not null;
create unique index if not exists phoenix_crm_manager_plan_customers_own_uniq
  on public.phoenix_crm_manager_plan_customers (slot_id, manager_customer_id) where manager_customer_id is not null;
create index if not exists phoenix_crm_manager_plan_customers_customer_idx
  on public.phoenix_crm_manager_plan_customers (customer_id) where customer_id is not null;
create index if not exists phoenix_crm_manager_plan_customers_own_idx
  on public.phoenix_crm_manager_plan_customers (manager_customer_id) where manager_customer_id is not null;

-- ── 5. The week's trail ────────────────────────────────────────────────────────────────────────

create table if not exists public.phoenix_crm_manager_plan_events (
  id bigint generated always as identity primary key,
  plan_id uuid not null references public.phoenix_crm_manager_plans (id) on delete cascade,
  event_type text not null,
  actor_hr_id text not null,
  actor_role text,
  from_status text,
  to_status text,
  version integer,
  note text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint phoenix_crm_manager_plan_events_type check (
    event_type in ('created', 'submitted', 'first_approved', 'approved', 'returned', 'edit_asked', 'reopened', 'edit_refused', 'edit_expired')
  ),
  constraint phoenix_crm_manager_plan_events_role check (
    actor_role is null or actor_role in ('manager', 'first', 'second', 'administrator', 'system')
  )
);

create index if not exists phoenix_crm_manager_plan_events_plan_idx
  on public.phoenix_crm_manager_plan_events (plan_id, created_at);

-- ── 6. His ask to edit a sent week ─────────────────────────────────────────────────────────────

create table if not exists public.phoenix_crm_manager_plan_edit_requests (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.phoenix_crm_manager_plans (id) on delete cascade,
  manager_hr_id text not null,
  week_start date not null,
  approver_hr_id text not null,
  reason text not null,
  status text not null default 'pending',
  plan_status_at_raise text not null,
  decided_at timestamptz,
  decided_by_hr_id text,
  decided_role text,
  decision_note text,
  reopened_plan_version integer,
  version integer not null default 1,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_manager_plan_edit_requests_status check (status in ('pending', 'reopened', 'refused', 'expired')),
  constraint phoenix_crm_manager_plan_edit_requests_reason check (char_length(reason) between 3 and 500),
  constraint phoenix_crm_manager_plan_edit_requests_note check (decision_note is null or char_length(decision_note) <= 500),
  constraint phoenix_crm_manager_plan_edit_requests_role check (decided_role is null or decided_role in ('first', 'administrator', 'system')),
  constraint phoenix_crm_manager_plan_edit_requests_decided check ((status = 'pending') = (decided_at is null)),
  constraint phoenix_crm_manager_plan_edit_requests_upper check (
    manager_hr_id = upper(manager_hr_id) and approver_hr_id = upper(approver_hr_id)
  )
);

-- One ask waiting per week.
create unique index if not exists phoenix_crm_manager_plan_edit_requests_open_uniq
  on public.phoenix_crm_manager_plan_edit_requests (plan_id) where status = 'pending';
create index if not exists phoenix_crm_manager_plan_edit_requests_plan_idx
  on public.phoenix_crm_manager_plan_edit_requests (plan_id, created_at);
create index if not exists phoenix_crm_manager_plan_edit_requests_approver_idx
  on public.phoenix_crm_manager_plan_edit_requests (approver_hr_id, status, is_test);

-- ── 7. His own single visits ───────────────────────────────────────────────────────────────────

create table if not exists public.phoenix_crm_manager_visits (
  id uuid primary key default gen_random_uuid(),
  manager_hr_id text not null,
  manager_seat_id text,
  line_code text,
  -- The half-day it answers; null when he visited a customer he had not planned that day.
  plan_slot_id uuid references public.phoenix_crm_manager_plan_slots (id) on delete set null,
  is_unplanned boolean not null default false,
  visit_date date not null,
  half text,
  customer_id uuid references public.phoenix_crm_customers (id),
  manager_customer_id uuid references public.phoenix_crm_manager_customers (id),
  -- Optional, all of them (owner, 2026-10-16): no photo, no accuracy gate, products and comment optional.
  products text[] not null default '{}',
  comment text,
  lat double precision,
  lon double precision,
  accuracy_meters numeric,
  captured_at timestamptz not null default now(),
  client_ref text not null,
  entered_by_hr_id text not null,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  constraint phoenix_crm_manager_visits_one check ((customer_id is null) <> (manager_customer_id is null)),
  constraint phoenix_crm_manager_visits_half check (half is null or half in ('AM', 'PM')),
  constraint phoenix_crm_manager_visits_planned check (not (is_unplanned and plan_slot_id is not null)),
  constraint phoenix_crm_manager_visits_products check (cardinality(products) <= 12),
  constraint phoenix_crm_manager_visits_comment check (comment is null or char_length(comment) <= 1000),
  constraint phoenix_crm_manager_visits_pin check (
    (lat is null) = (lon is null)
    and (lat is null or (lat between 21.5 and 32 and lon between 24 and 37.5))
    and (accuracy_meters is null or accuracy_meters >= 0)
  ),
  constraint phoenix_crm_manager_visits_client_ref check (char_length(client_ref) between 8 and 100),
  constraint phoenix_crm_manager_visits_upper check (
    manager_hr_id = upper(manager_hr_id) and entered_by_hr_id = upper(entered_by_hr_id)
  )
);

comment on table public.phoenix_crm_manager_visits is
  'The single visits a district manager logs himself (owner, 2026-10-16), planned or not. They count in HIS actual-versus-planned report and nowhere else: no KPI, coverage, call-rate, frequency or target reader reads this table.';

create unique index if not exists phoenix_crm_manager_visits_client_ref_uniq
  on public.phoenix_crm_manager_visits (client_ref);
create unique index if not exists phoenix_crm_manager_visits_customer_day_uniq
  on public.phoenix_crm_manager_visits (manager_hr_id, customer_id, visit_date, is_test) where customer_id is not null;
create unique index if not exists phoenix_crm_manager_visits_own_day_uniq
  on public.phoenix_crm_manager_visits (manager_hr_id, manager_customer_id, visit_date, is_test) where manager_customer_id is not null;
create index if not exists phoenix_crm_manager_visits_day_idx
  on public.phoenix_crm_manager_visits (manager_hr_id, visit_date, is_test);
create index if not exists phoenix_crm_manager_visits_slot_idx
  on public.phoenix_crm_manager_visits (plan_slot_id) where plan_slot_id is not null;
create index if not exists phoenix_crm_manager_visits_customer_idx
  on public.phoenix_crm_manager_visits (customer_id) where customer_id is not null;
create index if not exists phoenix_crm_manager_visits_own_idx
  on public.phoenix_crm_manager_visits (manager_customer_id) where manager_customer_id is not null;

-- ── Row security: the same four statements, in the same order, as every table in this module ──
-- Revoking from public also strips service_role (a member of it), so the grant that follows is
-- mandatory. `drop policy if exists` keeps the file replayable.

alter table public.phoenix_crm_manager_plans enable row level security;
drop policy if exists phoenix_crm_manager_plans_service_role on public.phoenix_crm_manager_plans;
create policy phoenix_crm_manager_plans_service_role
  on public.phoenix_crm_manager_plans for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_manager_plans from public, anon, authenticated;
grant all on table public.phoenix_crm_manager_plans to service_role;

alter table public.phoenix_crm_manager_customers enable row level security;
drop policy if exists phoenix_crm_manager_customers_service_role on public.phoenix_crm_manager_customers;
create policy phoenix_crm_manager_customers_service_role
  on public.phoenix_crm_manager_customers for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_manager_customers from public, anon, authenticated;
grant all on table public.phoenix_crm_manager_customers to service_role;

alter table public.phoenix_crm_manager_plan_slots enable row level security;
drop policy if exists phoenix_crm_manager_plan_slots_service_role on public.phoenix_crm_manager_plan_slots;
create policy phoenix_crm_manager_plan_slots_service_role
  on public.phoenix_crm_manager_plan_slots for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_manager_plan_slots from public, anon, authenticated;
grant all on table public.phoenix_crm_manager_plan_slots to service_role;

alter table public.phoenix_crm_manager_plan_customers enable row level security;
drop policy if exists phoenix_crm_manager_plan_customers_service_role on public.phoenix_crm_manager_plan_customers;
create policy phoenix_crm_manager_plan_customers_service_role
  on public.phoenix_crm_manager_plan_customers for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_manager_plan_customers from public, anon, authenticated;
grant all on table public.phoenix_crm_manager_plan_customers to service_role;

alter table public.phoenix_crm_manager_plan_events enable row level security;
drop policy if exists phoenix_crm_manager_plan_events_service_role on public.phoenix_crm_manager_plan_events;
create policy phoenix_crm_manager_plan_events_service_role
  on public.phoenix_crm_manager_plan_events for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_manager_plan_events from public, anon, authenticated;
grant all on table public.phoenix_crm_manager_plan_events to service_role;

alter table public.phoenix_crm_manager_plan_edit_requests enable row level security;
drop policy if exists phoenix_crm_manager_plan_edit_requests_service_role on public.phoenix_crm_manager_plan_edit_requests;
create policy phoenix_crm_manager_plan_edit_requests_service_role
  on public.phoenix_crm_manager_plan_edit_requests for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_manager_plan_edit_requests from public, anon, authenticated;
grant all on table public.phoenix_crm_manager_plan_edit_requests to service_role;

alter table public.phoenix_crm_manager_visits enable row level security;
drop policy if exists phoenix_crm_manager_visits_service_role on public.phoenix_crm_manager_visits;
create policy phoenix_crm_manager_visits_service_role
  on public.phoenix_crm_manager_visits for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_manager_visits from public, anon, authenticated;
grant all on table public.phoenix_crm_manager_visits to service_role;

-- ── Setting, changing or clearing one half-day ─────────────────────────────────────────────────
--
-- p: manager_hr_id, manager_seat_id, line_code, actor_hr_id, plan_date, half,
--    kind ('with_rep' | 'admin' | 'single_visit'; null clears the half-day),
--    rep_seat_id, rep_hr_id (with_rep), activity_type (admin), area_seat_id, area_code, area_name
--    (single_visit), note, customers: [{ customer_id } | { manager_customer_id }],
--    expected_version (the week's version the screen showed; null while it has no row), is_test
create or replace function public.phoenix_crm_save_manager_plan_slot(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_manager text := upper(nullif(trim(coalesce(p ->> 'manager_hr_id', '')), ''));
  v_seat text := nullif(trim(coalesce(p ->> 'manager_seat_id', '')), '');
  v_line text := nullif(trim(coalesce(p ->> 'line_code', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_date date := nullif(p ->> 'plan_date', '')::date;
  v_half text := coalesce(p ->> 'half', '');
  v_kind text := nullif(trim(coalesce(p ->> 'kind', '')), '');
  v_rep_seat text := nullif(trim(coalesce(p ->> 'rep_seat_id', '')), '');
  v_rep text := upper(nullif(trim(coalesce(p ->> 'rep_hr_id', '')), ''));
  v_activity text := nullif(trim(coalesce(p ->> 'activity_type', '')), '');
  v_area_seat text := nullif(trim(coalesce(p ->> 'area_seat_id', '')), '');
  v_area_code text := nullif(trim(coalesce(p ->> 'area_code', '')), '');
  v_area_name text := nullif(trim(coalesce(p ->> 'area_name', '')), '');
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_customers jsonb := coalesce(p -> 'customers', '[]'::jsonb);
  v_expected integer := nullif(p ->> 'expected_version', '')::integer;
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_week date;
  v_this_week date;
  v_plan public.phoenix_crm_manager_plans%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_slot_id uuid;
  v_entry jsonb;
  v_cid uuid;
  v_mcid uuid;
begin
  if v_manager is null or v_seat is null or v_actor is null or v_date is null or v_half not in ('AM', 'PM') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if jsonb_typeof(v_customers) <> 'array' or jsonb_array_length(v_customers) > 60 then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- Each kind carries its own fields and nothing else; a clear carries nothing.
  if v_kind is null then
    if jsonb_array_length(v_customers) > 0 then
      raise exception 'phoenix_crm:bad_input';
    end if;
  elsif v_kind = 'with_rep' then
    if v_rep_seat is null or v_rep is null or v_activity is not null or v_area_code is not null then
      raise exception 'phoenix_crm:bad_input';
    end if;
  elsif v_kind = 'admin' then
    if v_activity is null or v_activity not in ('meeting', 'training', 'conference', 'admin_work', 'travel', 'health_day', 'sales_day')
       or v_rep_seat is not null or v_area_code is not null or jsonb_array_length(v_customers) > 0 then
      raise exception 'phoenix_crm:bad_input';
    end if;
  elsif v_kind = 'single_visit' then
    if v_area_code is null or v_rep_seat is not null or v_activity is not null then
      raise exception 'phoenix_crm:bad_input';
    end if;
  else
    raise exception 'phoenix_crm:manager_plan_bad_kind';
  end if;
  -- A half-day with a rep or on a single visit names the customers he will see.
  if v_kind in ('with_rep', 'single_visit') and jsonb_array_length(v_customers) = 0 then
    raise exception 'phoenix_crm:manager_plan_slot_empty';
  end if;

  -- The field week: Saturday to Wednesday, AM and PM; Thursday a morning; never a Friday.
  if extract(isodow from v_date) = 5 or (extract(isodow from v_date) = 4 and v_half = 'PM') then
    raise exception 'phoenix_crm:manager_plan_not_field_time';
  end if;
  -- A day that has passed keeps its plan, so actual against planned still reads what was planned.
  if v_date < v_today then
    raise exception 'phoenix_crm:manager_plan_day_passed';
  end if;
  -- calendar.ts fieldWeekStart in SQL. The week he is in and the coming one — the application narrows
  -- it to the one he plans (the coming week, or the week he is in while he never sent it).
  v_week := v_date - ((extract(isodow from v_date)::integer + 1) % 7);
  v_this_week := v_today - ((extract(isodow from v_today)::integer + 1) % 7);
  if v_week not in (v_this_week, v_this_week + 7) then
    raise exception 'phoenix_crm:manager_plan_week_closed';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('phoenix_crm:manager_plan:' || v_manager || ':' || v_week::text || ':' || v_is_test::text)
  );

  select pl.* into v_plan
  from public.phoenix_crm_manager_plans pl
  where pl.manager_hr_id = v_manager and pl.week_start = v_week and pl.is_test = v_is_test
  for update;

  if not found then
    -- The screen showed no week, so it sends no version. Anything else means another screen made it.
    if v_expected is not null then
      raise exception 'phoenix_crm:version_conflict';
    end if;
    if v_kind is null then
      return jsonb_build_object('plan_id', null, 'version', null, 'status', null, 'week_start', v_week, 'slot_id', null);
    end if;
    insert into public.phoenix_crm_manager_plans
      (manager_hr_id, manager_seat_id, line_code, week_start, status, version, due_on, created_by_hr_id, is_test)
    values
      (v_manager, v_seat, v_line, v_week, 'draft', 1, public.phoenix_crm_week_due_on(v_week), v_actor, v_is_test)
    returning * into v_plan;
    insert into public.phoenix_crm_manager_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version)
    values (v_plan.id, 'created', v_actor, case when v_actor = v_manager then 'manager' else 'administrator' end, null, 'draft', v_plan.version);
  else
    if v_expected is distinct from v_plan.version then
      raise exception 'phoenix_crm:version_conflict';
    end if;
    -- A sent week changes only through his ask to edit it, decided above him.
    if v_plan.status not in ('draft', 'returned') then
      raise exception 'phoenix_crm:manager_plan_not_editable';
    end if;
    -- A week returned for ONE day changes on that day alone.
    if v_plan.status = 'returned' and v_plan.returned_day is not null and v_date <> v_plan.returned_day then
      raise exception 'phoenix_crm:manager_plan_day_not_returned';
    end if;
  end if;

  delete from public.phoenix_crm_manager_plan_slots s
  where s.plan_id = v_plan.id and s.plan_date = v_date and s.half = v_half;

  if v_kind is not null then
    insert into public.phoenix_crm_manager_plan_slots
      (plan_id, week_start, plan_date, half, kind, rep_seat_id, rep_hr_id, activity_type, area_seat_id, area_code, area_name, note)
    values
      (v_plan.id, v_week, v_date, v_half, v_kind,
       case when v_kind = 'with_rep' then v_rep_seat end,
       case when v_kind = 'with_rep' then v_rep end,
       case when v_kind = 'admin' then v_activity end,
       case when v_kind = 'single_visit' then v_area_seat end,
       case when v_kind = 'single_visit' then v_area_code end,
       case when v_kind = 'single_visit' then v_area_name end,
       v_note)
    returning id into v_slot_id;

    for v_entry in select value from jsonb_array_elements(v_customers) loop
      v_cid := nullif(v_entry ->> 'customer_id', '')::uuid;
      v_mcid := nullif(v_entry ->> 'manager_customer_id', '')::uuid;
      if (v_cid is null) = (v_mcid is null) then
        raise exception 'phoenix_crm:bad_input';
      end if;
      if v_cid is not null then
        select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_cid;
        if not found or v_customer.is_test <> v_is_test or v_customer.status = 'dropped' then
          raise exception 'phoenix_crm:manager_plan_customer_gone';
        end if;
        -- With a rep, every customer is that rep's own.
        if v_kind = 'with_rep' and v_customer.seat_id <> v_rep_seat then
          raise exception 'phoenix_crm:manager_plan_customer_not_reps';
        end if;
        insert into public.phoenix_crm_manager_plan_customers (slot_id, customer_id, source_seat_id, list_type)
        values (v_slot_id, v_cid, v_customer.seat_id, v_customer.list_type)
        on conflict do nothing;
      else
        -- His own list belongs to his single visits, and to him.
        if v_kind <> 'single_visit' then
          raise exception 'phoenix_crm:bad_input';
        end if;
        if not exists (
          select 1 from public.phoenix_crm_manager_customers m
          where m.id = v_mcid and m.manager_hr_id = v_manager and m.is_test = v_is_test and m.status <> 'removed'
        ) then
          raise exception 'phoenix_crm:manager_plan_customer_gone';
        end if;
        insert into public.phoenix_crm_manager_plan_customers (slot_id, manager_customer_id)
        values (v_slot_id, v_mcid)
        on conflict do nothing;
      end if;
    end loop;
  end if;

  update public.phoenix_crm_manager_plans pl
  set version = pl.version + 1,
      updated_at = now()
  where pl.id = v_plan.id
  returning pl.* into v_plan;

  return jsonb_build_object(
    'plan_id', v_plan.id,
    'version', v_plan.version,
    'status', v_plan.status,
    'week_start', v_plan.week_start,
    'slot_id', v_slot_id
  );
end;
$$;

-- ── Send, approve, return ──────────────────────────────────────────────────────────────────────
--
-- p: plan_id, action ('submit' | 'approve' | 'return'), actor_hr_id,
--    actor_role ('manager' or 'administrator' on a send; 'first', 'second' or 'administrator' on a
--    decision), stage ('first' | 'second' on a decision — whose turn is being decided),
--    first_approver_hr_id, second_approver_hr_id (on a send), note, day (a one-day return),
--    expected_version, is_test
create or replace function public.phoenix_crm_manager_plan_transition(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_plan_id uuid := nullif(p ->> 'plan_id', '')::uuid;
  v_action text := coalesce(p ->> 'action', '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_role text := nullif(trim(coalesce(p ->> 'actor_role', '')), '');
  v_stage text := nullif(trim(coalesce(p ->> 'stage', '')), '');
  v_first text := upper(nullif(trim(coalesce(p ->> 'first_approver_hr_id', '')), ''));
  v_second text := upper(nullif(trim(coalesce(p ->> 'second_approver_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_expected integer := nullif(p ->> 'expected_version', '')::integer;
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_day date := nullif(p ->> 'day', '')::date;
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_manager text;
  v_week date;
  v_plan public.phoenix_crm_manager_plans%rowtype;
  v_from text;
  v_event text;
  v_details jsonb := '{}'::jsonb;
begin
  if v_plan_id is null or v_actor is null or v_action not in ('submit', 'approve', 'return') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_day is not null and v_action <> 'return' then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_action = 'submit' and (v_role is null or v_role not in ('manager', 'administrator')) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_action <> 'submit' and (v_stage is null or v_stage not in ('first', 'second')
     or v_role is null or v_role not in ('first', 'second', 'administrator')) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- An approver decides only his own stage; the Administrator may decide either.
  if v_action <> 'submit' and v_role <> 'administrator' and v_role <> v_stage then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select pl.manager_hr_id, pl.week_start into v_manager, v_week
  from public.phoenix_crm_manager_plans pl where pl.id = v_plan_id;
  if not found then
    raise exception 'phoenix_crm:manager_plan_not_found';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('phoenix_crm:manager_plan:' || v_manager || ':' || v_week::text || ':' || v_is_test::text)
  );

  select pl.* into v_plan from public.phoenix_crm_manager_plans pl where pl.id = v_plan_id for update;
  if v_plan.is_test <> v_is_test then
    raise exception 'phoenix_crm:manager_plan_not_found';
  end if;
  if v_expected is distinct from v_plan.version then
    raise exception 'phoenix_crm:version_conflict';
  end if;
  v_from := v_plan.status;
  if v_action <> 'approve' and v_plan.week_start + 5 < v_today then
    raise exception 'phoenix_crm:week_passed';
  end if;

  if v_action = 'submit' then
    if v_from not in ('draft', 'returned') then
      raise exception 'phoenix_crm:bad_transition';
    end if;
    if not exists (select 1 from public.phoenix_crm_manager_plan_slots s where s.plan_id = v_plan.id) then
      raise exception 'phoenix_crm:empty_plan';
    end if;
    if v_first is null then
      raise exception 'phoenix_crm:manager_plan_no_approver';
    end if;
    if v_first = v_plan.manager_hr_id or v_second = v_plan.manager_hr_id or v_second = v_first then
      raise exception 'phoenix_crm:bad_input';
    end if;
    -- Judged against its own deadline, 23:55 Cairo on its due date, from the server's clock, and
    -- accepted whenever it arrives. A week sent again after his approver reopened it keeps the verdict
    -- its first send earned: the change was agreed above him and must not read as lateness.
    update public.phoenix_crm_manager_plans pl
    set status = 'submitted',
        submitted_at = now(),
        submitted_by_hr_id = v_actor,
        due_on = public.phoenix_crm_week_due_on(pl.week_start),
        submitted_late = case
          when pl.submitted_late is not null and exists (
            select 1 from public.phoenix_crm_manager_plan_edit_requests r where r.plan_id = pl.id and r.status = 'reopened'
          ) then pl.submitted_late
          else now() > public.phoenix_crm_week_deadline_at(pl.week_start)
        end,
        first_approver_hr_id = v_first,
        second_approver_hr_id = v_second,
        first_decided_at = null,
        first_decided_by_hr_id = null,
        first_decided_role = null,
        first_decision_note = null,
        decided_at = null,
        decided_by_hr_id = null,
        decided_by_role = null,
        decision_note = null,
        returned_day = null,
        returned_stage = null,
        version = pl.version + 1,
        updated_at = now()
    where pl.id = v_plan.id
    returning pl.* into v_plan;
    v_event := 'submitted';
    -- WHAT WAS SENT, kept on the send's own event: every half-day with its customers' names as they stood.
    v_details := jsonb_build_object(
      'slots', coalesce((
        select jsonb_agg(
                 jsonb_build_object(
                   'plan_date', s.plan_date, 'half', s.half, 'kind', s.kind,
                   'rep_seat_id', s.rep_seat_id, 'rep_hr_id', s.rep_hr_id,
                   'activity_type', s.activity_type, 'area_code', s.area_code, 'area_name', s.area_name,
                   'customers', coalesce((
                     select jsonb_agg(jsonb_build_object(
                              'customer_id', pc.customer_id,
                              'manager_customer_id', pc.manager_customer_id,
                              'name', coalesce(c.name, m.name))
                            order by coalesce(c.name, m.name), pc.id)
                     from public.phoenix_crm_manager_plan_customers pc
                     left join public.phoenix_crm_customers c on c.id = pc.customer_id
                     left join public.phoenix_crm_manager_customers m on m.id = pc.manager_customer_id
                     where pc.slot_id = s.id
                   ), '[]'::jsonb))
                 order by s.plan_date, s.half)
        from public.phoenix_crm_manager_plan_slots s
        where s.plan_id = v_plan.id
      ), '[]'::jsonb)
    );

  elsif v_action = 'approve' then
    if v_stage = 'first' then
      if v_from <> 'submitted' then
        raise exception 'phoenix_crm:bad_transition';
      end if;
      update public.phoenix_crm_manager_plans pl
      set status = case when pl.second_approver_hr_id is null then 'approved' else 'first_approved' end,
          first_decided_at = now(),
          first_decided_by_hr_id = v_actor,
          first_decided_role = v_role,
          first_decision_note = v_note,
          decided_at = case when pl.second_approver_hr_id is null then now() end,
          decided_by_hr_id = case when pl.second_approver_hr_id is null then v_actor end,
          decided_by_role = case when pl.second_approver_hr_id is null then v_role end,
          decision_note = case when pl.second_approver_hr_id is null then v_note end,
          version = pl.version + 1,
          updated_at = now()
      where pl.id = v_plan.id
      returning pl.* into v_plan;
    else
      if v_from <> 'first_approved' or v_plan.second_approver_hr_id is null then
        raise exception 'phoenix_crm:bad_transition';
      end if;
      update public.phoenix_crm_manager_plans pl
      set status = 'approved',
          decided_at = now(),
          decided_by_hr_id = v_actor,
          decided_by_role = v_role,
          decision_note = v_note,
          version = pl.version + 1,
          updated_at = now()
      where pl.id = v_plan.id
      returning pl.* into v_plan;
    end if;
    v_event := case when v_plan.status = 'first_approved' then 'first_approved' else 'approved' end;

  else
    -- The first approver returns a week waiting on him (or one he closed alone); the second returns one
    -- waiting on him or one he approved.
    if v_stage = 'first' and not (v_from = 'submitted' or (v_from = 'approved' and v_plan.second_approver_hr_id is null)) then
      raise exception 'phoenix_crm:bad_transition';
    end if;
    if v_stage = 'second' and not (v_from in ('first_approved', 'approved') and v_plan.second_approver_hr_id is not null) then
      raise exception 'phoenix_crm:bad_transition';
    end if;
    if v_note is null then
      raise exception 'phoenix_crm:note_required';
    end if;
    -- ONE DAY: a working day of this week that has not passed — he must still be able to change it.
    if v_day is not null and (v_day < v_plan.week_start or v_day > v_plan.week_start + 5 or v_day < v_today) then
      raise exception 'phoenix_crm:day_not_returnable';
    end if;
    update public.phoenix_crm_manager_plans pl
    set status = 'returned',
        returned_day = v_day,
        returned_stage = v_stage,
        decided_at = now(),
        decided_by_hr_id = v_actor,
        decided_by_role = v_role,
        decision_note = v_note,
        version = pl.version + 1,
        updated_at = now()
    where pl.id = v_plan.id
    returning pl.* into v_plan;
    v_event := 'returned';
    v_details := jsonb_build_object('stage', v_stage)
      || case when v_day is not null then jsonb_build_object('returned_day', v_day) else '{}'::jsonb end;
  end if;

  insert into public.phoenix_crm_manager_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version, note, details)
  values (v_plan.id, v_event, v_actor, v_role, v_from, v_plan.status, v_plan.version, v_note, v_details);

  return jsonb_build_object(
    'plan_id', v_plan.id,
    'manager_hr_id', v_plan.manager_hr_id,
    'manager_seat_id', v_plan.manager_seat_id,
    'week_start', v_plan.week_start,
    'status', v_plan.status,
    'from_status', v_from,
    'version', v_plan.version,
    'due_on', v_plan.due_on,
    'submitted_late', v_plan.submitted_late,
    'first_approver_hr_id', v_plan.first_approver_hr_id,
    'second_approver_hr_id', v_plan.second_approver_hr_id,
    'returned_day', v_plan.returned_day,
    'is_test', v_plan.is_test
  );
end;
$$;

-- ── His ask to edit a sent week ────────────────────────────────────────────────────────────────
--
-- p: plan_id, actor_hr_id, approver_hr_id (his first approver — Hany for Hany's district managers),
--    reason, is_test
create or replace function public.phoenix_crm_raise_manager_plan_edit(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_plan_id uuid := nullif(p ->> 'plan_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_approver text := upper(nullif(trim(coalesce(p ->> 'approver_hr_id', '')), ''));
  v_reason text := nullif(regexp_replace(trim(coalesce(p ->> 'reason', '')), '\s+', ' ', 'g'), '');
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_manager text;
  v_week date;
  v_plan public.phoenix_crm_manager_plans%rowtype;
  v_request public.phoenix_crm_manager_plan_edit_requests%rowtype;
begin
  if v_plan_id is null or v_actor is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception 'phoenix_crm:note_required';
  end if;
  if v_approver is null then
    raise exception 'phoenix_crm:manager_plan_no_approver';
  end if;

  select pl.manager_hr_id, pl.week_start into v_manager, v_week
  from public.phoenix_crm_manager_plans pl where pl.id = v_plan_id;
  if not found then
    raise exception 'phoenix_crm:manager_plan_not_found';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('phoenix_crm:manager_plan:' || v_manager || ':' || v_week::text || ':' || v_is_test::text)
  );

  select pl.* into v_plan from public.phoenix_crm_manager_plans pl where pl.id = v_plan_id for update;
  if v_plan.is_test <> v_is_test then
    raise exception 'phoenix_crm:manager_plan_not_found';
  end if;
  if v_approver = v_plan.manager_hr_id then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_plan.status not in ('submitted', 'first_approved', 'approved') then
    raise exception 'phoenix_crm:bad_transition';
  end if;
  if v_plan.week_start + 5 < v_today then
    raise exception 'phoenix_crm:week_passed';
  end if;
  if exists (select 1 from public.phoenix_crm_manager_plan_edit_requests r where r.plan_id = v_plan.id and r.status = 'pending') then
    raise exception 'phoenix_crm:manager_plan_edit_already_open';
  end if;

  insert into public.phoenix_crm_manager_plan_edit_requests
    (plan_id, manager_hr_id, week_start, approver_hr_id, reason, status, plan_status_at_raise, is_test)
  values
    (v_plan.id, v_plan.manager_hr_id, v_plan.week_start, v_approver, v_reason, 'pending', v_plan.status, v_plan.is_test)
  returning * into v_request;

  insert into public.phoenix_crm_manager_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version, note, details)
  values (v_plan.id, 'edit_asked', v_actor, case when v_actor = v_plan.manager_hr_id then 'manager' else 'administrator' end,
          v_plan.status, v_plan.status, v_plan.version, v_reason, jsonb_build_object('request_id', v_request.id));

  return jsonb_build_object(
    'request_id', v_request.id,
    'plan_id', v_plan.id,
    'manager_hr_id', v_plan.manager_hr_id,
    'week_start', v_plan.week_start,
    'approver_hr_id', v_request.approver_hr_id,
    'status', v_request.status,
    'version', v_request.version,
    'is_test', v_request.is_test
  );
end;
$$;

-- ── Reopen or refuse his ask ───────────────────────────────────────────────────────────────────
--
-- p: request_id, decision ('reopen' | 'refuse'), actor_hr_id, actor_role ('first' | 'administrator'),
--    note (required to refuse), expected_version (the request's), is_test
create or replace function public.phoenix_crm_decide_manager_plan_edit(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_request_id uuid := nullif(p ->> 'request_id', '')::uuid;
  v_decision text := coalesce(p ->> 'decision', '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_role text := nullif(trim(coalesce(p ->> 'actor_role', '')), '');
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_expected integer := nullif(p ->> 'expected_version', '')::integer;
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_manager text;
  v_week date;
  v_plan_id uuid;
  v_request public.phoenix_crm_manager_plan_edit_requests%rowtype;
  v_plan public.phoenix_crm_manager_plans%rowtype;
  v_from text;
begin
  if v_request_id is null or v_actor is null or v_decision not in ('reopen', 'refuse')
     or v_role is null or v_role not in ('first', 'administrator') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select r.manager_hr_id, r.week_start, r.plan_id into v_manager, v_week, v_plan_id
  from public.phoenix_crm_manager_plan_edit_requests r where r.id = v_request_id;
  if not found then
    raise exception 'phoenix_crm:manager_plan_edit_not_found';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('phoenix_crm:manager_plan:' || v_manager || ':' || v_week::text || ':' || v_is_test::text)
  );

  select r.* into v_request from public.phoenix_crm_manager_plan_edit_requests r where r.id = v_request_id for update;
  select pl.* into v_plan from public.phoenix_crm_manager_plans pl where pl.id = v_plan_id for update;
  if v_request.is_test <> v_is_test or v_plan.is_test <> v_is_test then
    raise exception 'phoenix_crm:manager_plan_edit_not_found';
  end if;
  if v_expected is distinct from v_request.version then
    raise exception 'phoenix_crm:version_conflict';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'phoenix_crm:manager_plan_edit_decided';
  end if;
  if v_plan.week_start + 5 < v_today then
    raise exception 'phoenix_crm:week_passed';
  end if;

  if v_decision = 'refuse' then
    if v_note is null then
      raise exception 'phoenix_crm:note_required';
    end if;
    update public.phoenix_crm_manager_plan_edit_requests r
    set status = 'refused',
        decided_at = now(),
        decided_by_hr_id = v_actor,
        decided_role = v_role,
        decision_note = v_note,
        version = r.version + 1,
        updated_at = now()
    where r.id = v_request.id
    returning r.* into v_request;
    insert into public.phoenix_crm_manager_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version, note, details)
    values (v_plan.id, 'edit_refused', v_actor, v_role, v_plan.status, v_plan.status, v_plan.version, v_note,
            jsonb_build_object('request_id', v_request.id));
  else
    if v_plan.status not in ('submitted', 'first_approved', 'approved') then
      raise exception 'phoenix_crm:bad_transition';
    end if;
    v_from := v_plan.status;
    update public.phoenix_crm_manager_plans pl
    set status = 'draft',
        returned_day = null,
        returned_stage = null,
        first_decided_at = null,
        first_decided_by_hr_id = null,
        first_decided_role = null,
        first_decision_note = null,
        decided_at = null,
        decided_by_hr_id = null,
        decided_by_role = null,
        decision_note = null,
        version = pl.version + 1,
        updated_at = now()
    where pl.id = v_plan.id
    returning pl.* into v_plan;
    update public.phoenix_crm_manager_plan_edit_requests r
    set status = 'reopened',
        decided_at = now(),
        decided_by_hr_id = v_actor,
        decided_role = v_role,
        decision_note = v_note,
        reopened_plan_version = v_plan.version,
        version = r.version + 1,
        updated_at = now()
    where r.id = v_request.id
    returning r.* into v_request;
    insert into public.phoenix_crm_manager_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version, note, details)
    values (v_plan.id, 'reopened', v_actor, v_role, v_from, 'draft', v_plan.version, v_note,
            jsonb_build_object('request_id', v_request.id));
  end if;

  return jsonb_build_object(
    'request_id', v_request.id,
    'plan_id', v_plan.id,
    'manager_hr_id', v_plan.manager_hr_id,
    'week_start', v_plan.week_start,
    'status', v_request.status,
    'plan_status', v_plan.status,
    'plan_version', v_plan.version,
    'is_test', v_request.is_test
  );
end;
$$;

-- ── An ask nobody answered before its week ended ───────────────────────────────────────────────
--
-- p: unused (the module's one calling shape). It picks its rows itself, in this transaction.
create or replace function public.phoenix_crm_expire_manager_plan_edit_requests(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_expired jsonb;
begin
  with expired as (
    update public.phoenix_crm_manager_plan_edit_requests r
    set status = 'expired',
        decided_at = now(),
        decided_by_hr_id = null,
        decided_role = 'system',
        version = r.version + 1,
        updated_at = now()
    where r.status = 'pending'
      and r.week_start + 5 < v_today
    returning r.*
  ), trail as (
    insert into public.phoenix_crm_manager_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version, details)
    select e.plan_id, 'edit_expired', 'SYSTEM', 'system', pl.status, pl.status, pl.version, jsonb_build_object('request_id', e.id)
    from expired e
    join public.phoenix_crm_manager_plans pl on pl.id = e.plan_id
    returning 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'request_id', e.id, 'plan_id', e.plan_id, 'manager_hr_id', e.manager_hr_id,
           'approver_hr_id', e.approver_hr_id, 'week_start', e.week_start, 'is_test', e.is_test)), '[]'::jsonb)
  into v_expired
  from expired e;
  -- A data-modifying WITH runs to completion whether or not the outer query reads it, so the trail is
  -- written for every row the update expired.
  return jsonb_build_object('expired', v_expired);
end;
$$;

-- ── Taking a customer off his own list ─────────────────────────────────────────────────────────
--
-- p: manager_customer_id, actor_hr_id, approver_hr_id, reason, is_test
create or replace function public.phoenix_crm_request_manager_customer_removal(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'manager_customer_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_approver text := upper(nullif(trim(coalesce(p ->> 'approver_hr_id', '')), ''));
  v_reason text := nullif(regexp_replace(trim(coalesce(p ->> 'reason', '')), '\s+', ' ', 'g'), '');
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_row public.phoenix_crm_manager_customers%rowtype;
begin
  if v_id is null or v_actor is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception 'phoenix_crm:note_required';
  end if;
  if v_approver is null then
    raise exception 'phoenix_crm:manager_plan_no_approver';
  end if;

  select m.* into v_row from public.phoenix_crm_manager_customers m where m.id = v_id for update;
  if not found or v_row.is_test <> v_is_test then
    raise exception 'phoenix_crm:manager_customer_not_found';
  end if;
  if v_approver = v_row.manager_hr_id then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_row.status <> 'active' then
    raise exception 'phoenix_crm:manager_customer_not_active';
  end if;

  update public.phoenix_crm_manager_customers m
  set status = 'removal_pending',
      removal_reason = v_reason,
      removal_requested_at = now(),
      removal_requested_by_hr_id = v_actor,
      removal_approver_hr_id = v_approver,
      removal_decided_at = null,
      removal_decided_by_hr_id = null,
      removal_decided_role = null,
      removal_decision_note = null,
      updated_at = now()
  where m.id = v_row.id
  returning m.* into v_row;

  return jsonb_build_object(
    'manager_customer_id', v_row.id,
    'manager_hr_id', v_row.manager_hr_id,
    'name', v_row.name,
    'status', v_row.status,
    'approver_hr_id', v_row.removal_approver_hr_id,
    'is_test', v_row.is_test
  );
end;
$$;

-- p: manager_customer_id, decision ('approve' | 'refuse'), actor_hr_id, actor_role ('first' |
--    'administrator'), note (required to refuse), is_test
create or replace function public.phoenix_crm_decide_manager_customer_removal(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'manager_customer_id', '')::uuid;
  v_decision text := coalesce(p ->> 'decision', '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_role text := nullif(trim(coalesce(p ->> 'actor_role', '')), '');
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_row public.phoenix_crm_manager_customers%rowtype;
begin
  if v_id is null or v_actor is null or v_decision not in ('approve', 'refuse')
     or v_role is null or v_role not in ('first', 'administrator') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_decision = 'refuse' and v_note is null then
    raise exception 'phoenix_crm:note_required';
  end if;

  select m.* into v_row from public.phoenix_crm_manager_customers m where m.id = v_id for update;
  if not found or v_row.is_test <> v_is_test then
    raise exception 'phoenix_crm:manager_customer_not_found';
  end if;
  if v_row.status <> 'removal_pending' then
    raise exception 'phoenix_crm:manager_customer_removal_decided';
  end if;

  update public.phoenix_crm_manager_customers m
  set status = case when v_decision = 'approve' then 'removed' else 'active' end,
      removal_decided_at = now(),
      removal_decided_by_hr_id = v_actor,
      removal_decided_role = v_role,
      removal_decision_note = v_note,
      updated_at = now()
  where m.id = v_row.id
  returning m.* into v_row;

  return jsonb_build_object(
    'manager_customer_id', v_row.id,
    'manager_hr_id', v_row.manager_hr_id,
    'name', v_row.name,
    'status', v_row.status,
    'decision', v_decision,
    'is_test', v_row.is_test
  );
end;
$$;

-- ── The duplicate merge: the manager's rows follow the customer ────────────────────────────────

create or replace function public.phoenix_crm_merge_duplicate_customer(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_keeper_id uuid := nullif(p ->> 'keeper_id', '')::uuid;
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_loser_ids uuid[];
  v_keeper public.phoenix_crm_customers%rowtype;
  v_loser public.phoenix_crm_customers%rowtype;
  v_loser_id uuid;
  v_n integer;
  v_places integer := 0;
  v_visits integer := 0;
  v_reviews integer := 0;
  v_plan_items integer := 0;
  v_unplanned integer := 0;
  v_asks integer := 0;
  v_requests integer := 0;
  v_withdrawn integer := 0;
  v_manager_plan integer := 0;
  v_manager_visits integer := 0;
begin
  select coalesce(array_agg(distinct x::uuid), '{}')
  into v_loser_ids
  from jsonb_array_elements_text(coalesce(p -> 'loser_ids', '[]'::jsonb)) as x;

  if v_actor is null or v_keeper_id is null or cardinality(v_loser_ids) = 0 then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_keeper_id = any (v_loser_ids) then
    raise exception 'phoenix_crm:keeper_is_loser';
  end if;
  if v_note is null or char_length(v_note) < 10 or char_length(v_note) > 500 then
    raise exception 'phoenix_crm:note_required';
  end if;

  select c.* into v_keeper from public.phoenix_crm_customers c where c.id = v_keeper_id for update;
  if not found then
    raise exception 'phoenix_crm:customer_not_found';
  end if;
  if v_keeper.status = 'dropped' then
    raise exception 'phoenix_crm:customer_dropped';
  end if;

  -- The seat's own lock, the key phoenix_crm_move_customer takes, so a merge and a move on one list
  -- can never interleave.
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_keeper.seat_id));

  foreach v_loser_id in array v_loser_ids loop
    select c.* into v_loser from public.phoenix_crm_customers c where c.id = v_loser_id for update;
    if not found then
      raise exception 'phoenix_crm:customer_not_found';
    end if;
    if v_loser.status = 'dropped' then
      raise exception 'phoenix_crm:customer_dropped';
    end if;
    if v_loser.seat_id <> v_keeper.seat_id or v_loser.is_test <> v_keeper.is_test then
      raise exception 'phoenix_crm:not_same_list';
    end if;
    if v_loser.list_type <> v_keeper.list_type then
      raise exception 'phoenix_crm:list_type_differs';
    end if;
    if v_loser.validated_at is not null and v_keeper.validated_at is null then
      raise exception 'phoenix_crm:keeper_not_validated';
    end if;
    if exists (select 1 from public.phoenix_crm_places pl where pl.customer_id = v_loser.id and pl.status = 'active')
       and not exists (select 1 from public.phoenix_crm_places pl where pl.customer_id = v_keeper.id and pl.status = 'active') then
      raise exception 'phoenix_crm:keeper_holds_no_place';
    end if;
    if exists (select 1 from public.phoenix_crm_customer_moves m where m.customer_id = v_loser.id) then
      raise exception 'phoenix_crm:loser_has_moves';
    end if;

    -- The four unique keys a repoint could collide on. Each measured 0 on 2026-10-08; each still
    -- refuses, so a collision can never be resolved silently by whichever row the update hit first.
    if exists (
      select 1 from public.phoenix_crm_visits a
      join public.phoenix_crm_visits b
        on b.seat_id = a.seat_id and b.visit_date = a.visit_date and b.is_test = a.is_test
      where a.customer_id = v_loser.id and b.customer_id = v_keeper.id
    ) then
      raise exception 'phoenix_crm:visit_same_day';
    end if;
    if exists (
      select 1 from public.phoenix_crm_plan_items a
      join public.phoenix_crm_plan_items b on b.plan_id = a.plan_id and b.plan_date = a.plan_date
      where a.customer_id = v_loser.id and b.customer_id = v_keeper.id
    ) then
      raise exception 'phoenix_crm:plan_same_day';
    end if;
    if exists (
      select 1 from public.phoenix_crm_visit_asks a
      join public.phoenix_crm_visit_asks b
        on b.seat_id = a.seat_id and b.kind = a.kind and b.is_test = a.is_test and b.status = 'waiting'
      where a.customer_id = v_loser.id and a.status = 'waiting' and b.customer_id = v_keeper.id
    ) then
      raise exception 'phoenix_crm:ask_waiting_twice';
    end if;
    -- The district manager's own visit (owner, 2026-10-16): one per customer per day, like a rep's.
    if exists (
      select 1 from public.phoenix_crm_manager_visits a
      join public.phoenix_crm_manager_visits b
        on b.manager_hr_id = a.manager_hr_id and b.visit_date = a.visit_date and b.is_test = a.is_test
      where a.customer_id = v_loser.id and b.customer_id = v_keeper.id
    ) then
      raise exception 'phoenix_crm:manager_visit_same_day';
    end if;

    -- Anything still waiting on the loser is withdrawn first — something waiting on a row that has
    -- left the list is a decision nobody can take — which also clears the one-pending unique key.
    with withdrawn as (
      update public.phoenix_crm_list_requests q
      set status = 'withdrawn',
          stage = null,
          decided_at = now(),
          decided_by_hr_id = v_actor,
          decision_note = 'Merged into the same customer entered once on this list'
      where q.customer_id = v_loser.id
        and q.status = 'pending'
      returning q.id
    )
    insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
    select v_loser.seat_id, v_loser.id, w.id, 'request_withdrawn', v_actor, jsonb_build_object('why', 'merged'), v_loser.is_test
    from withdrawn w;
    get diagnostics v_n = row_count;
    v_withdrawn := v_withdrawn + v_n;

    update public.phoenix_crm_places set customer_id = v_keeper.id where customer_id = v_loser.id;
    get diagnostics v_n = row_count;
    v_places := v_places + v_n;
    update public.phoenix_crm_visits set customer_id = v_keeper.id where customer_id = v_loser.id;
    get diagnostics v_n = row_count;
    v_visits := v_visits + v_n;
    update public.phoenix_crm_validation_reviews set customer_id = v_keeper.id where customer_id = v_loser.id;
    get diagnostics v_n = row_count;
    v_reviews := v_reviews + v_n;
    update public.phoenix_crm_plan_items set customer_id = v_keeper.id where customer_id = v_loser.id;
    get diagnostics v_n = row_count;
    v_plan_items := v_plan_items + v_n;
    update public.phoenix_crm_unplanned_visits set customer_id = v_keeper.id where customer_id = v_loser.id;
    get diagnostics v_n = row_count;
    v_unplanned := v_unplanned + v_n;
    update public.phoenix_crm_visit_asks set customer_id = v_keeper.id where customer_id = v_loser.id;
    get diagnostics v_n = row_count;
    v_asks := v_asks + v_n;
    update public.phoenix_crm_list_requests set customer_id = v_keeper.id where customer_id = v_loser.id;
    get diagnostics v_n = row_count;
    v_requests := v_requests + v_n;
    -- The district manager's half-day already holding the keeper keeps that one row: it is one person.
    delete from public.phoenix_crm_manager_plan_customers a
    where a.customer_id = v_loser.id
      and exists (
        select 1 from public.phoenix_crm_manager_plan_customers b
        where b.slot_id = a.slot_id and b.customer_id = v_keeper.id
      );
    update public.phoenix_crm_manager_plan_customers set customer_id = v_keeper.id where customer_id = v_loser.id;
    get diagnostics v_n = row_count;
    v_manager_plan := v_manager_plan + v_n;
    update public.phoenix_crm_manager_visits set customer_id = v_keeper.id where customer_id = v_loser.id;
    get diagnostics v_n = row_count;
    v_manager_visits := v_manager_visits + v_n;

    update public.phoenix_crm_customers c
    set status = 'dropped',
        dropped_reason = 'duplicate',
        dropped_note = v_note,
        status_changed_at = now(),
        updated_at = now()
    where c.id = v_loser.id;

    -- Two events on the one list's trail, the shape phoenix_crm_move_customer writes: the row that
    -- left reads where it went, and the row that stayed reads what joined it.
    insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
    values
      (v_loser.seat_id, v_loser.id, 'customer_merged_out', v_actor,
       jsonb_build_object('into_customer_id', v_keeper.id, 'note', v_note), v_loser.is_test),
      (v_keeper.seat_id, v_keeper.id, 'customer_merged_in', v_actor,
       jsonb_build_object('from_customer_id', v_loser.id, 'note', v_note), v_keeper.is_test);
  end loop;

  -- The five-active-place cap, after the repoint, so it reads exactly what the keeper now holds.
  select count(*) into v_n from public.phoenix_crm_places pl where pl.customer_id = v_keeper.id and pl.status = 'active';
  if v_n > 5 then
    raise exception 'phoenix_crm:too_many_places';
  end if;

  return jsonb_build_object(
    'keeper_id', v_keeper.id,
    'merged', cardinality(v_loser_ids),
    'places', v_places,
    'visits', v_visits,
    'validation_reviews', v_reviews,
    'plan_items', v_plan_items,
    'unplanned_visits', v_unplanned,
    'visit_asks', v_asks,
    'list_requests', v_requests,
    'requests_withdrawn', v_withdrawn,
    'manager_plan_customers', v_manager_plan,
    'manager_visits', v_manager_visits
  );
end;
$$;

-- check:migrations refuses a file whose SECURITY DEFINER functions carry no revoke from PUBLIC.
revoke execute on function public.phoenix_crm_save_manager_plan_slot(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_save_manager_plan_slot(jsonb) to service_role;
revoke execute on function public.phoenix_crm_manager_plan_transition(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_manager_plan_transition(jsonb) to service_role;
revoke execute on function public.phoenix_crm_raise_manager_plan_edit(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_raise_manager_plan_edit(jsonb) to service_role;
revoke execute on function public.phoenix_crm_decide_manager_plan_edit(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_decide_manager_plan_edit(jsonb) to service_role;
revoke execute on function public.phoenix_crm_expire_manager_plan_edit_requests(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_expire_manager_plan_edit_requests(jsonb) to service_role;
revoke execute on function public.phoenix_crm_request_manager_customer_removal(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_request_manager_customer_removal(jsonb) to service_role;
revoke execute on function public.phoenix_crm_decide_manager_customer_removal(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_decide_manager_customer_removal(jsonb) to service_role;
revoke execute on function public.phoenix_crm_merge_duplicate_customer(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_merge_duplicate_customer(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
