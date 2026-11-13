create extension if not exists pgcrypto;

create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts >= 1),
  next_attempt_at timestamptz null default now(),
  locked_at timestamptz null,
  sent_at timestamptz null,
  provider_message_id text null,
  last_error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists notification_outbox_status_next_attempt_idx
  on public.notification_outbox (status, next_attempt_at, created_at);

create index if not exists notification_outbox_created_at_idx
  on public.notification_outbox (created_at desc);

alter table public.notification_outbox enable row level security;

revoke all on public.notification_outbox from anon, authenticated;
grant all on public.notification_outbox to service_role;

notify pgrst, 'reload schema';
