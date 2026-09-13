-- Native visits — working on an approved vacation day (CRM phase 6, rule 9).
--
-- WHAT THIS IS. From the CRM cutover date a rep cannot submit a visit on a day HR approved as his
-- vacation, unless he sent a request and BOTH his manager and HR approved it (owner, 2026-09-13:
-- "He's unable to submit a visit in it, except if he send a request to his manager and the HR").
-- The block itself is enforced by the native-visits service; this table holds the request and the
-- two decisions.
--
-- WHAT IT DOES NOT TOUCH. The approved vacation stays approved — nothing here edits
-- v2_vacation_requests, a balance, attendance, a deduction or pay. No report, KPI or board reads
-- these tables. While crm_cutover.cutover_date is null the service never looks at them.
--
-- WHAT IS HERE.
--   crm_native_visit_vacation_day_requests  one live request per rep per day. The manager is the
--                           rep's nearest active manager when he asked, stored, and only that
--                           person answers as manager. HR answers as HR. Each decision is its own
--                           pair of columns and moves once, from pending. A refusal must say why.
--                           Nobody decides their own request, and one person cannot be both deciders.
--   crm_native_visit_vacation_day_request_events  append-only history.
--
-- RLS on, nothing granted to anon or authenticated; every read and write goes through the
-- service-role client behind the app's own permission and scope checks.

begin;

create table if not exists public.crm_native_visit_vacation_day_requests (
  id uuid primary key default gen_random_uuid(),
  hr_id text not null references public.employees (hr_id),
  visit_date date not null,
  reason text not null,
  line_name text,
  manager_hr_id text not null references public.employees (hr_id),
  manager_decision text not null default 'pending',
  manager_decided_by text,
  manager_decided_at timestamptz,
  manager_note text,
  hr_decision text not null default 'pending',
  hr_decided_by text references public.employees (hr_id),
  hr_decided_at timestamptz,
  hr_note text,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_native_visit_vacation_day_requests_reason check (
    btrim(reason) <> '' and char_length(reason) <= 1000
  ),
  constraint crm_native_visit_vacation_day_requests_not_own_manager check (manager_hr_id <> hr_id),
  constraint crm_native_visit_vacation_day_requests_manager_decision check (
    manager_decision in ('pending', 'approved', 'rejected')
  ),
  constraint crm_native_visit_vacation_day_requests_hr_decision check (
    hr_decision in ('pending', 'approved', 'rejected')
  ),
  -- The manager's decision is always the stored manager's own, and a refusal says why.
  constraint crm_native_visit_vacation_day_requests_manager_workflow check (
    case manager_decision
      when 'pending' then manager_decided_by is null and manager_decided_at is null and manager_note is null
      when 'approved' then manager_decided_by = manager_hr_id and manager_decided_at is not null
      when 'rejected' then manager_decided_by = manager_hr_id and manager_decided_at is not null
        and manager_note is not null and btrim(manager_note) <> ''
      else false
    end
  ),
  -- HR's decision is never the rep's own and never the manager's second vote.
  constraint crm_native_visit_vacation_day_requests_hr_workflow check (
    case hr_decision
      when 'pending' then hr_decided_by is null and hr_decided_at is null and hr_note is null
      when 'approved' then hr_decided_by is not null and hr_decided_at is not null
        and hr_decided_by <> hr_id and hr_decided_by <> manager_hr_id
      when 'rejected' then hr_decided_by is not null and hr_decided_at is not null
        and hr_decided_by <> hr_id and hr_decided_by <> manager_hr_id
        and hr_note is not null and btrim(hr_note) <> ''
      else false
    end
  )
);

comment on table public.crm_native_visit_vacation_day_requests is
  'A rep''s request to enter visits on an HR-approved vacation day (CRM phase 6, rule 9). Allowed only when both the stored manager and HR approved it; never decided by the system. Read by nothing but the native-visits module.';

-- One live request per rep and day: a refused or withdrawn one leaves room to ask again.
create unique index if not exists crm_native_visit_vacation_day_requests_one_live
  on public.crm_native_visit_vacation_day_requests (hr_id, visit_date)
  where cancelled_at is null and manager_decision <> 'rejected' and hr_decision <> 'rejected';

create index if not exists crm_native_visit_vacation_day_requests_manager_idx
  on public.crm_native_visit_vacation_day_requests (manager_hr_id, manager_decision);

create index if not exists crm_native_visit_vacation_day_requests_hr_idx
  on public.crm_native_visit_vacation_day_requests (hr_decision, visit_date);

create table if not exists public.crm_native_visit_vacation_day_request_events (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.crm_native_visit_vacation_day_requests (id) on delete restrict,
  event text not null,
  actor_hr_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint crm_native_visit_vacation_day_request_events_event check (
    event in ('requested', 'manager_approved', 'manager_rejected', 'hr_approved', 'hr_rejected', 'cancelled')
  )
);

comment on table public.crm_native_visit_vacation_day_request_events is
  'Append-only history of every vacation-day work request: requested, each decision, cancelled.';

create index if not exists crm_native_visit_vacation_day_request_events_request_idx
  on public.crm_native_visit_vacation_day_request_events (request_id, created_at);

alter table public.crm_native_visit_vacation_day_requests enable row level security;
alter table public.crm_native_visit_vacation_day_request_events enable row level security;

revoke all on table public.crm_native_visit_vacation_day_requests from anon, authenticated;
revoke all on table public.crm_native_visit_vacation_day_request_events from anon, authenticated;
revoke all on sequence public.crm_native_visit_vacation_day_request_events_id_seq from anon, authenticated;

commit;

-- ROLLBACK. Safe only while no rep has sent a real request (check `select count(*) from
-- public.crm_native_visit_vacation_day_requests` first — a request is evidence, and production has
-- no PITR):
--   begin;
--   drop table if exists public.crm_native_visit_vacation_day_request_events;
--   drop table if exists public.crm_native_visit_vacation_day_requests;
--   commit;
