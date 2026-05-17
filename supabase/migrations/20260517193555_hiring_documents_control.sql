create extension if not exists pgcrypto;

create table if not exists public.hiring_document_definitions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text null,
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists hiring_document_definitions_active_name_idx
  on public.hiring_document_definitions (lower(trim(name)))
  where is_active;

create index if not exists hiring_document_definitions_active_order_idx
  on public.hiring_document_definitions (is_active, display_order, name);

create table if not exists public.hiring_document_statuses (
  employee_hr_id text not null references public.employees(hr_id) on update cascade on delete cascade,
  document_id uuid not null references public.hiring_document_definitions(id) on delete cascade,
  status text not null default 'pending',
  due_date date null,
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (employee_hr_id, document_id),
  constraint hiring_document_statuses_status_check
    check (status in ('pending', 'submitted', 'missing'))
);

create index if not exists hiring_document_statuses_document_idx
  on public.hiring_document_statuses (document_id);

create index if not exists hiring_document_statuses_employee_status_idx
  on public.hiring_document_statuses (employee_hr_id, status);

create table if not exists public.hiring_document_employee_notes (
  employee_hr_id text primary key references public.employees(hr_id) on update cascade on delete cascade,
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.hiring_document_definitions enable row level security;
alter table public.hiring_document_statuses enable row level security;
alter table public.hiring_document_employee_notes enable row level security;

grant select, insert, update, delete on public.hiring_document_definitions to authenticated, service_role;
grant select, insert, update, delete on public.hiring_document_statuses to authenticated, service_role;
grant select, insert, update, delete on public.hiring_document_employee_notes to authenticated, service_role;

drop policy if exists phx_hiring_document_definitions_service_role on public.hiring_document_definitions;
create policy phx_hiring_document_definitions_service_role
  on public.hiring_document_definitions
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists phx_hiring_document_statuses_service_role on public.hiring_document_statuses;
create policy phx_hiring_document_statuses_service_role
  on public.hiring_document_statuses
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists phx_hiring_document_employee_notes_service_role on public.hiring_document_employee_notes;
create policy phx_hiring_document_employee_notes_service_role
  on public.hiring_document_employee_notes
  for all
  to service_role
  using (true)
  with check (true);

insert into public.hiring_document_definitions (name, description, display_order)
values
  ('National ID copy', 'Official national identity copy.', 10),
  ('Birth certificate', 'Employee birth certificate copy.', 20),
  ('Graduation certificate', 'Education or graduation certificate.', 30),
  ('Military status', 'Military service or exemption document.', 40),
  ('Criminal record', 'Recent criminal record certificate.', 50),
  ('Personal photos', 'Required onboarding personal photos.', 60),
  ('Bank account details', 'Bank account or payment details document.', 70),
  ('Social insurance form', 'Social insurance onboarding form.', 80),
  ('Medical check', 'Pre-employment medical check document.', 90)
on conflict do nothing;
