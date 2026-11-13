alter table public.app_auth_users
  add column if not exists failed_login_attempts integer not null default 0;

alter table public.app_auth_users
  add column if not exists last_failed_login_at timestamptz null;

alter table public.app_auth_users
  add column if not exists locked_until timestamptz null;

create index if not exists app_auth_users_locked_until_idx
  on public.app_auth_users (locked_until)
  where locked_until is not null;

create index if not exists app_auth_users_login_lockout_idx
  on public.app_auth_users (login_id, locked_until);
