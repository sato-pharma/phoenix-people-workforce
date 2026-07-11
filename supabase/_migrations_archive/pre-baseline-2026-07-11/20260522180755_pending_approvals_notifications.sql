begin;
alter table public.leave_requests
  drop constraint if exists leave_requests_status_check;
alter table public.leave_requests
  add constraint leave_requests_status_check
  check (status in (
    'draft',
    'pending_manager',
    'manager_approved',
    'manager_rejected',
    'pending_hr',
    'hr_approved',
    'hr_rejected',
    'approved',
    'rejected',
    'cancelled'
  ));
create table if not exists public.notification_event_reads (
  id uuid primary key default gen_random_uuid(),
  notification_event_id uuid not null references public.notification_events(id) on update cascade on delete cascade,
  employee_hr_id text not null,
  read_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint notification_event_reads_unique unique (notification_event_id, employee_hr_id)
);
create index if not exists notification_event_reads_employee_idx
  on public.notification_event_reads (employee_hr_id, read_at desc);
create index if not exists notification_event_reads_event_idx
  on public.notification_event_reads (notification_event_id);
alter table public.notification_event_reads enable row level security;
revoke all on table public.notification_event_reads from anon, authenticated;
grant all on table public.notification_event_reads to service_role;
drop policy if exists notification_event_reads_service_role_all on public.notification_event_reads;
create policy notification_event_reads_service_role_all
  on public.notification_event_reads
  for all
  to service_role
  using (true)
  with check (true);
notify pgrst, 'reload schema';
commit;
