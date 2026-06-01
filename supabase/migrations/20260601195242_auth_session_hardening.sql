-- Auth session hardening.
-- Adds server-owned Phoenix application sessions so signed cookies are only
-- accepted while their database session is still active.

begin;

create table if not exists public.app_sessions (
  id uuid primary key,
  login_id text not null,
  hr_id text null,
  role text not null,
  session_version integer not null default 1,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz null,
  revoked_reason text null,
  ip text null,
  user_agent text null,
  supabase_session_required boolean not null default false,
  supabase_session_available boolean not null default false,
  constraint app_sessions_version_check check (session_version >= 1),
  constraint app_sessions_expiry_check check (absolute_expires_at > created_at and idle_expires_at > created_at)
);

create index if not exists app_sessions_login_id_idx
  on public.app_sessions (login_id);

create index if not exists app_sessions_revoked_at_idx
  on public.app_sessions (revoked_at);

create index if not exists app_sessions_idle_expires_at_idx
  on public.app_sessions (idle_expires_at);

create index if not exists app_sessions_absolute_expires_at_idx
  on public.app_sessions (absolute_expires_at);

create or replace function public.api_rate_limit_consume(
  p_bucket_key text,
  p_limit integer,
  p_window_ms integer
)
returns table (
  allowed boolean,
  retry_after_seconds integer
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_reset_at timestamptz := now() + ((greatest(p_window_ms, 1)::double precision / 1000.0) * interval '1 second');
  v_count integer;
  v_current_reset_at timestamptz;
begin
  insert into public.api_rate_limit_buckets (bucket_key, request_count, reset_at, updated_at)
  values (p_bucket_key, 1, v_reset_at, v_now)
  on conflict (bucket_key) do update
  set request_count = case
        when public.api_rate_limit_buckets.reset_at <= v_now then 1
        else public.api_rate_limit_buckets.request_count + 1
      end,
      reset_at = case
        when public.api_rate_limit_buckets.reset_at <= v_now then v_reset_at
        else public.api_rate_limit_buckets.reset_at
      end,
      updated_at = v_now
  returning request_count, reset_at
  into v_count, v_current_reset_at;

  allowed := v_count <= p_limit;
  retry_after_seconds := case
    when allowed then 0
    else greatest(1, ceil(extract(epoch from (v_current_reset_at - v_now)))::integer)
  end;
  return next;
end;
$$;

alter table public.app_sessions enable row level security;

revoke all on table public.app_sessions from anon, authenticated;
grant select, insert, update, delete on table public.app_sessions to service_role;
revoke all on function public.api_rate_limit_consume(text, integer, integer) from public;
grant execute on function public.api_rate_limit_consume(text, integer, integer) to service_role;

drop policy if exists app_sessions_service_role_all on public.app_sessions;
create policy app_sessions_service_role_all
  on public.app_sessions
  for all
  to service_role
  using (true)
  with check (true);

notify pgrst, 'reload schema';

commit;
