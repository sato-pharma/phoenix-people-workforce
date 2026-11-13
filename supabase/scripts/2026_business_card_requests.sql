-- Employee business-card requests
-- Used by /employee-portals/business-cards: an employee opens their own card,
-- corrects the name and number that will print (never the email — that stays
-- the record's, server-side), and asks HR to print business cards. Each request
-- lands on the consolidated HR queue at /business-card-requests, and notifies the
-- owner (B-10) and HR Operations (HR-009) by in-app, email and Telegram.
--
-- The card's title, line·area and email are snapshotted server-side at request
-- time so the HR queue prints exactly what was asked for even if the register
-- changes afterwards. Only the name and mobile are the employee's to type; the
-- request never writes back to the `employees` record.
--
-- Status is worked by HR downstream: Pending | In Progress | Printed | Cancelled.

create table if not exists public.business_card_requests (
  id uuid primary key default gen_random_uuid(),
  hr_id text not null,
  employee_name text not null,
  card_name text not null,
  card_title text,
  card_line_area text,
  card_mobile text,
  card_email text,
  note text,
  status text not null default 'Pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists business_card_requests_hr_id_created_at_idx
  on public.business_card_requests (hr_id, created_at desc);

create index if not exists business_card_requests_status_idx
  on public.business_card_requests (status);

comment on table public.business_card_requests is
  'Employee self-service business-card print requests, worked through by HR.';
comment on column public.business_card_requests.status is
  'Pending | In Progress | Printed | Cancelled.';
comment on column public.business_card_requests.card_email is
  'Snapshot of the work email at request time — never editable by the employee.';

-- Touch updated_at on row modification.
-- search_path is pinned empty (the body only calls now(), from pg_catalog) so the
-- function is not flagged function_search_path_mutable by the security linter.
create or replace function public.business_card_requests_touch()
returns trigger language plpgsql
set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists business_card_requests_touch on public.business_card_requests;
create trigger business_card_requests_touch
  before update on public.business_card_requests
  for each row execute function public.business_card_requests_touch();
