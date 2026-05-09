-- Phoenix Workforce
-- Phase 1/2 auth + audit governance hardening.
-- Adds durable metadata for session revocation, richer audit provenance,
-- and user-agent capture for login attempt telemetry.

alter table if exists public.app_auth_users
  add column if not exists last_password_reset_at timestamptz null;

alter table if exists public.app_auth_users
  add column if not exists last_role_change_at timestamptz null;

alter table if exists public.app_auth_users
  add column if not exists last_session_revocation_at timestamptz null;

alter table if exists public.app_auth_users
  add column if not exists last_session_revocation_reason text null;

alter table if exists public.auth_login_attempts
  add column if not exists user_agent text null;

alter table if exists public.audit_logs
  add column if not exists actor_hr_id text null;

alter table if exists public.audit_logs
  add column if not exists actor_role text null;

alter table if exists public.audit_logs
  add column if not exists request_ip text null;

alter table if exists public.audit_logs
  add column if not exists user_agent text null;

create index if not exists app_auth_users_last_session_revocation_at_idx
  on public.app_auth_users (last_session_revocation_at desc)
  where last_session_revocation_at is not null;

create index if not exists audit_logs_actor_hr_id_idx
  on public.audit_logs (actor_hr_id);

create index if not exists audit_logs_request_ip_idx
  on public.audit_logs (request_ip);

create index if not exists auth_login_attempts_user_agent_idx
  on public.auth_login_attempts (attempted_at desc, user_agent);
