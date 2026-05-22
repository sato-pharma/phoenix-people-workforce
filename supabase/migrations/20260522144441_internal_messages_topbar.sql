create table if not exists public.internal_messages (
  id uuid primary key default gen_random_uuid(),
  sender_login_id text null,
  sender_hr_id text null,
  sender_name text not null,
  recipient_login_id text null,
  recipient_hr_id text null,
  recipient_name text not null,
  recipient_email text null,
  subject text not null,
  body text not null,
  source text not null default 'topbar',
  email_status text not null default 'not_requested',
  email_provider_id text null,
  email_error text null,
  read_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint internal_messages_email_status_check check (
    email_status in ('not_requested', 'pending', 'sent', 'skipped', 'failed')
  )
);

alter table public.internal_messages
  add column if not exists sender_login_id text null,
  add column if not exists sender_hr_id text null,
  add column if not exists sender_name text not null default 'Phoenix User',
  add column if not exists recipient_login_id text null,
  add column if not exists recipient_hr_id text null,
  add column if not exists recipient_name text not null default 'Phoenix User',
  add column if not exists recipient_email text null,
  add column if not exists subject text not null default 'Internal message',
  add column if not exists body text not null default '',
  add column if not exists source text not null default 'topbar',
  add column if not exists email_status text not null default 'not_requested',
  add column if not exists email_provider_id text null,
  add column if not exists email_error text null,
  add column if not exists read_at timestamptz null,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists internal_messages_recipient_hr_created_idx
  on public.internal_messages (recipient_hr_id, created_at desc);

create index if not exists internal_messages_recipient_login_created_idx
  on public.internal_messages (recipient_login_id, created_at desc);

create index if not exists internal_messages_sender_hr_created_idx
  on public.internal_messages (sender_hr_id, created_at desc);

create index if not exists internal_messages_sender_login_created_idx
  on public.internal_messages (sender_login_id, created_at desc);

alter table public.internal_messages enable row level security;

revoke all on public.internal_messages from anon, authenticated;
grant all on public.internal_messages to service_role;

drop policy if exists phx_internal_messages_service_role on public.internal_messages;
create policy phx_internal_messages_service_role
  on public.internal_messages
  for all
  to service_role
  using (true)
  with check (true);
