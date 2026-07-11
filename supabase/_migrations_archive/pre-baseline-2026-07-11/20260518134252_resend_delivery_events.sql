begin;
create extension if not exists pgcrypto;
create table if not exists public.email_delivery_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'resend',
  provider_event_id text not null unique,
  provider_message_id text null,
  event_type text not null,
  status text not null,
  subject text null,
  sender text null,
  recipients text[] not null default '{}'::text[],
  failure_reason text null,
  raw_event jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  received_at timestamptz not null default now()
);
create index if not exists email_delivery_events_message_idx
  on public.email_delivery_events (provider_message_id);
create index if not exists email_delivery_events_status_received_idx
  on public.email_delivery_events (status, received_at desc);
create index if not exists email_delivery_events_occurred_idx
  on public.email_delivery_events (occurred_at desc);
alter table public.email_delivery_events enable row level security;
revoke all on public.email_delivery_events from anon, authenticated;
grant all on public.email_delivery_events to service_role;
drop policy if exists phx_email_delivery_events_service_role on public.email_delivery_events;
create policy phx_email_delivery_events_service_role
  on public.email_delivery_events
  for all
  to service_role
  using (true)
  with check (true);
commit;
