create table if not exists public.v2_vacation_approval_steps (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.v2_vacation_requests(id) on update cascade on delete cascade,
  step_key text not null,
  approver_hr_id text not null,
  approver_user_id text null,
  status text not null default 'pending',
  decision_comment text null,
  decided_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint v2_vacation_approval_steps_step_key_check
    check (step_key in ('direct_manager', 'manager_of_manager', 'hr')),
  constraint v2_vacation_approval_steps_status_check
    check (status in ('pending', 'approved', 'rejected')),
  constraint v2_vacation_approval_steps_decision_timestamp_check
    check (
      (status = 'pending' and decided_at is null)
      or
      (status in ('approved', 'rejected') and decided_at is not null)
    )
);

create unique index if not exists v2_vacation_approval_steps_request_approver_uidx
  on public.v2_vacation_approval_steps (request_id, lower(approver_hr_id), coalesce(lower(approver_user_id), ''));

create index if not exists v2_vacation_approval_steps_request_status_idx
  on public.v2_vacation_approval_steps (request_id, status);

create index if not exists v2_vacation_approval_steps_approver_pending_idx
  on public.v2_vacation_approval_steps (lower(approver_hr_id), lower(coalesce(approver_user_id, '')), status)
  where status = 'pending';

alter table public.v2_vacation_approval_steps enable row level security;

revoke all on public.v2_vacation_approval_steps from anon, authenticated;
grant all on public.v2_vacation_approval_steps to service_role;
