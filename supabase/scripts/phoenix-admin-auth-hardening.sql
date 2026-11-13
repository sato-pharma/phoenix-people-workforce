alter table public.app_auth_users
  add column if not exists session_version integer not null default 1;

alter table public.app_auth_users
  add column if not exists force_password_reset boolean not null default false;

create table if not exists public.auth_login_attempts (
  id uuid primary key default gen_random_uuid(),
  login_id text not null,
  ip text null,
  success boolean not null default false,
  attempted_at timestamptz not null default now()
);

create index if not exists auth_login_attempts_login_ip_idx
  on public.auth_login_attempts (login_id, ip, attempted_at desc);

create index if not exists auth_login_attempts_attempted_at_idx
  on public.auth_login_attempts (attempted_at desc);
