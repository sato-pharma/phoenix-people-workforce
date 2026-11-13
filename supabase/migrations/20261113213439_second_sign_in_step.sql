-- second_sign_in_step — the three tables behind the second sign-in step (integration audit INT-005).
--
-- WHAT THIS CHANGES: adds three new tables. Nothing existing changes and no row is written.
--   1. public.app_auth_second_step — one row per sign-in account that has set up, or started setting up,
--      an authenticator app. The app's key is stored SEALED (AES-256-GCM, src/lib/security/secret-box.ts,
--      keyed from PHOENIX_AUTH_SECRET), never in plain text. last_used_step is the newest 30-second step a
--      code was accepted for, so one code cannot be used twice.
--   2. public.app_auth_second_step_recovery_codes — the ten one-time recovery codes of an account, as keyed
--      fingerprints (HMAC-SHA256), never the codes. used_at marks a spent one.
--   3. public.app_auth_trusted_devices — one row per browser that passed the step, holding the SHA-256
--      fingerprint of the random token in that browser's HttpOnly cookie and the day it stops counting
--      (30 days). The token itself is never stored.
-- WHY: until now a password alone opened every account (0 accounts had a second factor), so a stolen Super
--   Admin password opened payroll, permissions and every record. The owner's choices, 13 Nov 2026: "Super
--   Admin accounts only", "Authenticator app, passkey counts", "Once per device, 30 days", "Recovery codes
--   plus your reset".
-- ACCESS: read and written only by the server (service role). RLS is enabled with NO policy on all three,
--   and public, anon and authenticated hold no privilege, so the browser key can neither read nor write.
-- BREAK-GLASS: deleting an account's row from app_auth_second_step (its codes and devices go with it, by
--   the foreign keys' cascade) returns that account to "not set up": its next password sign-in is offered a
--   new set-up. That is the recovery of last resort if both Super Admin accounts are locked out.
-- ROLLBACK: drop table if exists public.app_auth_trusted_devices;
--           drop table if exists public.app_auth_second_step_recovery_codes;
--           drop table if exists public.app_auth_second_step;
--   (and ship the matching code revert FIRST: the sign-in route reads app_auth_second_step for a Super
--   Admin, and a missing table refuses that sign-in rather than letting it through.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This change is neither destructive nor bulk: three new, empty tables.

begin;

create table if not exists public.app_auth_second_step (
  login_id               text primary key references public.app_auth_users(login_id) on update cascade on delete cascade,
  -- The authenticator key in use, sealed. NULL until the first code was accepted.
  secret_sealed          text,
  -- A key handed over at sign-in and not yet confirmed by a code. Replaced after 15 minutes.
  pending_secret_sealed  text,
  pending_created_at     timestamptz,
  enrolled_at            timestamptz,
  -- The newest 30-second step a code was accepted for. A code of this step or an older one is refused.
  last_used_step         bigint,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

alter table public.app_auth_second_step enable row level security;

revoke all on table public.app_auth_second_step from public;
revoke all on table public.app_auth_second_step from anon;
revoke all on table public.app_auth_second_step from authenticated;
grant select, insert, update, delete on table public.app_auth_second_step to service_role;

comment on table public.app_auth_second_step is
  'The second sign-in step (authenticator app) of a sign-in account. One row per account that set it up or started to. The key is sealed, never plain. Server only: RLS on, no policy. Deleting a row returns the account to "not set up".';
comment on column public.app_auth_second_step.secret_sealed is
  'The authenticator key in use, sealed with AES-256-GCM (secret-box.ts, PHOENIX_AUTH_SECRET). NULL until set-up is finished.';
comment on column public.app_auth_second_step.last_used_step is
  'The newest 30-second step a code was accepted for; a code is good once.';

create table if not exists public.app_auth_second_step_recovery_codes (
  id          uuid primary key default gen_random_uuid(),
  login_id    text not null references public.app_auth_second_step(login_id) on update cascade on delete cascade,
  -- HMAC-SHA256 of the code, keyed with the server's secret. Never the code.
  code_hash   text not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now(),
  unique (login_id, code_hash)
);

alter table public.app_auth_second_step_recovery_codes enable row level security;

revoke all on table public.app_auth_second_step_recovery_codes from public;
revoke all on table public.app_auth_second_step_recovery_codes from anon;
revoke all on table public.app_auth_second_step_recovery_codes from authenticated;
grant select, insert, update, delete on table public.app_auth_second_step_recovery_codes to service_role;

comment on table public.app_auth_second_step_recovery_codes is
  'One-time recovery codes for the second sign-in step, ten per account, stored as keyed fingerprints. used_at marks a spent code. Server only: RLS on, no policy.';

create table if not exists public.app_auth_trusted_devices (
  id            uuid primary key default gen_random_uuid(),
  login_id      text not null references public.app_auth_second_step(login_id) on update cascade on delete cascade,
  -- SHA-256 of the random token in the browser's HttpOnly cookie. Never the token.
  token_hash    text not null unique,
  expires_at    timestamptz not null,
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

create index if not exists app_auth_trusted_devices_login_id_idx
  on public.app_auth_trusted_devices (login_id);

alter table public.app_auth_trusted_devices enable row level security;

revoke all on table public.app_auth_trusted_devices from public;
revoke all on table public.app_auth_trusted_devices from anon;
revoke all on table public.app_auth_trusted_devices from authenticated;
grant select, insert, update, delete on table public.app_auth_trusted_devices to service_role;

comment on table public.app_auth_trusted_devices is
  'Browsers that passed the second sign-in step and are not asked again until expires_at (30 days). Holds the fingerprint of the cookie token, never the token. Server only: RLS on, no policy.';

commit;
