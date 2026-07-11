-- Compatibility baseline for legacy index targets used by the
-- security-first performance migration.

begin;

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid null,
  body text null,
  created_at timestamptz not null default now()
);

alter table public.messages enable row level security;

alter table public.platform_settings
  add column if not exists updated_by_user_id uuid;

alter table public.system_audit_logs
  add column if not exists actor_user_id uuid;

alter table public.user_roles
  add column if not exists assigned_by_user_id uuid;

alter table public.job_offers
  add column if not exists created_by_hr_id text;

notify pgrst, 'reload schema';

commit;
