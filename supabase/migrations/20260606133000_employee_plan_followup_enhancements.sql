-- Weekly / Monthly Plan follow-up enhancements.
-- Additive only: stores row-level return feedback without changing legacy weekly_plans tables.

create table if not exists public.employee_plan_item_return_notes (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.employee_plan_headers(id) on delete cascade,
  item_id uuid references public.employee_plan_items(id) on delete set null,
  actor_hr_id text,
  actor_login_id text,
  actor_role text,
  action text not null check (action in ('manager_return', 'ceo_return')),
  activity_date date,
  activity_title text,
  sort_order integer,
  note text not null check (btrim(note) <> ''),
  created_at timestamptz not null default now()
);

create index if not exists employee_plan_item_return_notes_plan_idx
  on public.employee_plan_item_return_notes(plan_id, created_at desc);

create index if not exists employee_plan_item_return_notes_item_idx
  on public.employee_plan_item_return_notes(item_id, created_at desc);

alter table public.employee_plan_item_return_notes enable row level security;

revoke all on table public.employee_plan_item_return_notes from anon, authenticated;
grant select, insert, update, delete on public.employee_plan_item_return_notes to service_role;

drop policy if exists employee_plan_item_return_notes_service_role on public.employee_plan_item_return_notes;
create policy employee_plan_item_return_notes_service_role
  on public.employee_plan_item_return_notes
  for all
  to service_role
  using (true)
  with check (true);
