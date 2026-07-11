begin;
create table if not exists public.notification_user_states (
  id uuid primary key default gen_random_uuid(),
  notification_event_id uuid not null references public.notification_events(id) on update cascade on delete cascade,
  user_id text null,
  hr_id text null,
  read_at timestamptz null,
  archived_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_user_states_identity_check check (user_id is not null or hr_id is not null)
);
create unique index if not exists notification_user_states_user_unique_idx
  on public.notification_user_states (notification_event_id, user_id)
  where user_id is not null;
create unique index if not exists notification_user_states_hr_unique_idx
  on public.notification_user_states (notification_event_id, hr_id)
  where hr_id is not null;
create index if not exists notification_user_states_hr_unread_idx
  on public.notification_user_states (hr_id, read_at, updated_at desc)
  where archived_at is null;
create index if not exists notification_user_states_user_unread_idx
  on public.notification_user_states (user_id, read_at, updated_at desc)
  where archived_at is null;
alter table public.notification_user_states enable row level security;
revoke all on public.notification_user_states from anon, authenticated;
grant select, insert, update, delete on public.notification_user_states to service_role;
drop policy if exists phx_notification_user_states_service_role on public.notification_user_states;
create policy phx_notification_user_states_service_role
  on public.notification_user_states
  for all
  to service_role
  using (true)
  with check (true);
notify pgrst, 'reload schema';
commit;
