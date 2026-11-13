create table if not exists public.password_setup_tokens (
  id uuid primary key default gen_random_uuid(),
  login_id text not null references public.app_auth_users(login_id) on update cascade on delete cascade,
  purpose text not null check (purpose in ('setup', 'reset')),
  token_hash text not null unique,
  sent_to_email text null,
  created_by_login_id text null references public.app_auth_users(login_id) on update cascade on delete set null,
  expires_at timestamptz not null,
  used_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists password_setup_tokens_login_id_idx
  on public.password_setup_tokens (login_id, created_at desc);

create index if not exists password_setup_tokens_active_idx
  on public.password_setup_tokens (login_id, expires_at)
  where used_at is null;

notify pgrst, 'reload schema';
