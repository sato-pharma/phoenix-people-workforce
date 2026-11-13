-- Employee HR support requests
-- Used by /employee-portals/contact-hr-support form to persist tickets.
--
-- A "request" is a self-service ticket opened by an employee asking the HR /
-- Talent / Ops desk for help. Status is updated by HR admins downstream
-- (out-of-scope for this migration). Attachments are stored as a JSON array
-- of {name, size, type} entries — the actual file blobs go to Supabase
-- Storage in a follow-up (out-of-scope here; keeping schema permissive).

create table if not exists public.employee_support_requests (
  id uuid primary key default gen_random_uuid(),
  hr_id text not null,
  employee_name text not null,
  category text not null,
  subcategory text,
  subject text not null,
  description text not null,
  attachments jsonb not null default '[]'::jsonb,
  status text not null default 'Pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists employee_support_requests_hr_id_created_at_idx
  on public.employee_support_requests (hr_id, created_at desc);

create index if not exists employee_support_requests_status_idx
  on public.employee_support_requests (status);

comment on table public.employee_support_requests is
  'Self-service HR support tickets opened from the employee portal.';
comment on column public.employee_support_requests.status is
  'Pending | In Progress | Resolved | Closed.';
comment on column public.employee_support_requests.attachments is
  'JSON array of {name, size, type} entries.';

-- Touch updated_at on row modification
create or replace function public.employee_support_requests_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists employee_support_requests_touch on public.employee_support_requests;
create trigger employee_support_requests_touch
  before update on public.employee_support_requests
  for each row execute function public.employee_support_requests_touch();
