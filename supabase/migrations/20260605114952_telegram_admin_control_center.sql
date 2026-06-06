begin;

create table if not exists public.notification_channel_settings (
  channel text primary key,
  enabled_globally boolean not null default false,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_channel_settings_channel_check
    check (channel in ('in_app', 'email', 'telegram'))
);

create table if not exists public.notification_module_channel_policies (
  id uuid primary key default gen_random_uuid(),
  module text not null,
  channel text not null,
  enabled boolean not null default true,
  generic_only boolean not null default false,
  optional boolean not null default false,
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_module_channel_policies_channel_check
    check (channel in ('in_app', 'email', 'telegram')),
  constraint notification_module_channel_policies_module_channel_uniq
    unique (module, channel)
);

create index if not exists notification_module_channel_policies_channel_idx
  on public.notification_module_channel_policies (channel, module);

alter table public.notification_channel_settings enable row level security;
alter table public.notification_module_channel_policies enable row level security;

revoke all on public.notification_channel_settings from anon, authenticated;
revoke all on public.notification_module_channel_policies from anon, authenticated;

grant select, insert, update, delete on public.notification_channel_settings to service_role;
grant select, insert, update, delete on public.notification_module_channel_policies to service_role;

drop policy if exists phx_notification_channel_settings_service_role on public.notification_channel_settings;
create policy phx_notification_channel_settings_service_role
  on public.notification_channel_settings
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists phx_notification_module_channel_policies_service_role on public.notification_module_channel_policies;
create policy phx_notification_module_channel_policies_service_role
  on public.notification_module_channel_policies
  for all
  to service_role
  using (true)
  with check (true);

insert into public.notification_channel_settings (channel, enabled_globally, settings)
values ('telegram', false, '{"phase":"notification_only"}'::jsonb)
on conflict (channel) do nothing;

insert into public.notification_module_channel_policies (module, channel, enabled, generic_only, optional, notes)
values
  ('payroll', 'telegram', true, true, false, 'Sensitive payroll Telegram messages must be generic only.'),
  ('payslip', 'telegram', true, true, false, 'Payslip Telegram messages must only say the payslip is available.'),
  ('payslips', 'telegram', true, true, false, 'Payslip Telegram messages must only say the payslip is available.'),
  ('resignations', 'telegram', false, false, false, 'Disabled by default due resignation sensitivity.'),
  ('probation', 'telegram', true, false, false, 'Allowed only after governed recipient resolution.'),
  ('contract_renewal', 'telegram', true, false, false, 'Allowed for governed contract renewal recipients.'),
  ('contracts', 'telegram', true, false, false, 'Allowed for governed contract recipients.'),
  ('vacation', 'telegram', true, false, false, 'Allowed for direct manager governed vacation workflows.'),
  ('leave', 'telegram', true, false, false, 'Allowed for governed leave workflows.'),
  ('marketing_requests', 'telegram', true, false, false, 'Allowed only for assigned approvers/request owners resolved by policy.'),
  ('recruitment', 'telegram', true, false, false, 'Allowed for governed recruitment notifications.'),
  ('internal_messages', 'telegram', true, false, true, 'Optional Telegram channel for internal messages.'),
  ('system', 'telegram', true, false, true, 'Optional Telegram channel for system tests and announcements.')
on conflict (module, channel) do update
set
  enabled = excluded.enabled,
  generic_only = excluded.generic_only,
  optional = excluded.optional,
  notes = excluded.notes,
  updated_at = now();

notify pgrst, 'reload schema';

commit;
