-- Phoenix Workforce controlled email notification routing.
-- Keeps Resend delivery limited to approved HR workflow email types.

create table if not exists public.email_notification_policies (
  notification_type text primary key,
  label text not null,
  description text null,
  enabled boolean not null default true,
  recipient_mode text not null default 'hr_notifications',
  include_hr_inbox boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text null,
  constraint email_notification_policies_type_check
    check (notification_type in ('probation', 'contract_renewal', 'birthday', 'offer', 'resignation')),
  constraint email_notification_policies_recipient_mode_check
    check (recipient_mode in (
      'hr_notifications',
      'employee',
      'direct_manager',
      'manager_manager',
      'manager_chain',
      'employee_and_direct_manager',
      'candidate'
    ))
);

insert into public.email_notification_policies (
  notification_type,
  label,
  description,
  enabled,
  recipient_mode,
  include_hr_inbox
)
values
  ('probation', 'Probation', 'Probation review alerts routed through the reporting hierarchy.', true, 'direct_manager', true),
  ('contract_renewal', 'Contract renewal', 'Contract renewal workflow alerts routed to the manager chain.', true, 'manager_chain', true),
  ('birthday', 'Birthdays', 'Birthday wishes routed to the employee.', true, 'employee', false),
  ('offer', 'Offers', 'Offer lifecycle communication for candidates and HR follow-up.', true, 'candidate', false),
  ('resignation', 'Resignations', 'Resignation workflow alerts routed to the reporting chain.', true, 'manager_chain', true)
on conflict (notification_type) do update
set
  label = excluded.label,
  description = excluded.description;

alter table public.email_notification_policies enable row level security;

revoke all on public.email_notification_policies from anon, authenticated;
grant all on public.email_notification_policies to service_role;

drop policy if exists phx_email_notification_policies_service_role on public.email_notification_policies;
create policy phx_email_notification_policies_service_role
  on public.email_notification_policies
  for all
  to service_role
  using (true)
  with check (true);
