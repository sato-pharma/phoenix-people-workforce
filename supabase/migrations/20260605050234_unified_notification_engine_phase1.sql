begin;
create extension if not exists pgcrypto;
alter table public.notification_events
  add column if not exists module text null,
  add column if not exists event_type text null,
  add column if not exists priority text not null default 'normal',
  add column if not exists action_url text null,
  add column if not exists actor_id text null,
  add column if not exists recipient_user_id text null,
  add column if not exists sent_at timestamptz null;
alter table public.notification_events
  drop constraint if exists notification_events_priority_check,
  add constraint notification_events_priority_check
    check (priority in ('low', 'normal', 'high', 'critical'));
create index if not exists notification_events_module_event_idx
  on public.notification_events (module, event_type, created_at desc);
create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_event_id uuid not null references public.notification_events(id) on update cascade on delete cascade,
  channel text not null,
  recipient_user_id text null,
  recipient_hr_id text null,
  recipient_address text null,
  status text not null default 'pending',
  idempotency_key text not null,
  provider text null,
  provider_message_id text null,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz null default now(),
  last_error text null,
  metadata jsonb not null default '{}'::jsonb,
  sent_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_deliveries_channel_check
    check (channel in ('in_app', 'email', 'telegram')),
  constraint notification_deliveries_status_check
    check (status in ('pending', 'sent', 'failed', 'skipped', 'retrying')),
  constraint notification_deliveries_attempts_check check (attempts >= 0),
  constraint notification_deliveries_max_attempts_check check (max_attempts >= 1),
  constraint notification_deliveries_idempotency_uniq unique (idempotency_key)
);
create index if not exists notification_deliveries_event_idx
  on public.notification_deliveries (notification_event_id);
create index if not exists notification_deliveries_status_next_idx
  on public.notification_deliveries (channel, status, next_attempt_at, created_at);
create table if not exists public.notification_preferences (
  user_id text primary key,
  hr_id text null,
  email_enabled boolean not null default true,
  telegram_enabled boolean not null default false,
  in_app_enabled boolean not null default true,
  quiet_hours_start time null,
  quiet_hours_end time null,
  preferred_channel text not null default 'email',
  module_preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_preferences_preferred_channel_check
    check (preferred_channel in ('in_app', 'email', 'telegram'))
);
create index if not exists notification_preferences_hr_id_idx
  on public.notification_preferences (hr_id);
create table if not exists public.telegram_connections (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  hr_id text null,
  telegram_chat_id text null,
  telegram_username text null,
  status text not null default 'pending',
  connect_token_hash text null unique,
  connect_token_expires_at timestamptz null,
  connect_token_used_at timestamptz null,
  linked_at timestamptz null,
  disabled_at timestamptz null,
  failure_reason text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_connections_status_check
    check (status in ('pending', 'connected', 'disabled', 'failed'))
);
create unique index if not exists telegram_connections_user_active_idx
  on public.telegram_connections (user_id)
  where status in ('pending', 'connected', 'failed');
create index if not exists telegram_connections_hr_id_idx
  on public.telegram_connections (hr_id);
create index if not exists telegram_connections_chat_idx
  on public.telegram_connections (telegram_chat_id)
  where telegram_chat_id is not null;
create table if not exists public.notification_templates (
  template_key text primary key,
  module text not null,
  event_type text not null,
  channel text not null,
  title_template text not null,
  message_template text not null,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_templates_channel_check
    check (channel in ('in_app', 'email', 'telegram'))
);
create unique index if not exists notification_templates_module_event_channel_idx
  on public.notification_templates (module, event_type, channel);
alter table public.notification_deliveries enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.telegram_connections enable row level security;
alter table public.notification_templates enable row level security;
revoke all on public.notification_deliveries from anon, authenticated;
revoke all on public.notification_preferences from anon, authenticated;
revoke all on public.telegram_connections from anon, authenticated;
revoke all on public.notification_templates from anon, authenticated;
grant select, insert, update, delete on public.notification_deliveries to service_role;
grant select, insert, update, delete on public.notification_preferences to service_role;
grant select, insert, update, delete on public.telegram_connections to service_role;
grant select, insert, update, delete on public.notification_templates to service_role;
drop policy if exists phx_notification_deliveries_service_role on public.notification_deliveries;
create policy phx_notification_deliveries_service_role
  on public.notification_deliveries
  for all
  to service_role
  using (true)
  with check (true);
drop policy if exists phx_notification_preferences_service_role on public.notification_preferences;
create policy phx_notification_preferences_service_role
  on public.notification_preferences
  for all
  to service_role
  using (true)
  with check (true);
drop policy if exists phx_telegram_connections_service_role on public.telegram_connections;
create policy phx_telegram_connections_service_role
  on public.telegram_connections
  for all
  to service_role
  using (true)
  with check (true);
drop policy if exists phx_notification_templates_service_role on public.notification_templates;
create policy phx_notification_templates_service_role
  on public.notification_templates
  for all
  to service_role
  using (true)
  with check (true);
notify pgrst, 'reload schema';
commit;
