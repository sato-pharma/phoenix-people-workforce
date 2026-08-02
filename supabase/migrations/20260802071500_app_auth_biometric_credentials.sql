-- Biometric (passkey / WebAuthn) sign-in: credential store + challenge store.
--
-- Why: signing in on a phone means typing a login ID and password on a touch keyboard several
-- times a day. A passkey replaces that with Face ID / fingerprint / Windows Hello. The biometric
-- itself NEVER reaches Phoenix and is never stored here — the device keeps the private key in its
-- secure enclave, Phoenix keeps only the matching PUBLIC key and verifies a signature. There is no
-- fingerprint image, template, or face data in this schema, and there cannot be.
--
-- Security posture: a passkey is bound to the origin (phoenix-hr.satopharma.com) by the browser,
-- so it cannot be phished onto a lookalike domain the way a typed password can. This is a stronger
-- first factor than the password it stands beside, not a weaker one.
--
-- Both tables are service_role-only, matching public.app_sessions exactly: RLS on, anon and
-- authenticated revoked, service_role granted plus an explicit policy. Note the REVOKE targets
-- `anon, authenticated` and NOT `public` — revoking from PUBLIC would strip service_role's own
-- access through the default ACL and silently break every read below.

begin;

-- ---------------------------------------------------------------------------
-- Enrolled credentials. One row per device a person has enrolled.
-- ---------------------------------------------------------------------------
create table if not exists public.app_auth_credentials (
  id uuid primary key default gen_random_uuid(),
  -- base64url of the raw WebAuthn credential ID. Globally unique: it is how an incoming
  -- assertion is resolved back to a person, so a collision would be an identity mix-up.
  credential_id text not null unique,
  -- base64url of the COSE public key. Public by definition; leaking it grants nothing.
  public_key text not null,
  -- Authenticator's signature counter. A value that does not advance is the standard
  -- cloned-authenticator / replay signal. Some platform authenticators legitimately always
  -- report 0, so the application treats "both sides 0" as acceptable and anything that moves
  -- BACKWARDS as an attack.
  sign_count bigint not null default 0,
  -- Owner. No FK to app_auth_users on purpose: app_sessions.login_id has none either, login_id
  -- is matched case-insensitively at login, and a hard FK would make an employee-record repair
  -- fail with a constraint error instead of a handled one.
  login_id text not null,
  hr_id text null,
  -- What the person sees in "your enrolled devices", e.g. "iPhone (Safari)".
  device_label text not null,
  transports text[] null,
  -- True when the platform syncs the passkey across the person's devices (iCloud Keychain,
  -- Google Password Manager). Recorded so an admin can tell a single-device key from a synced one.
  backed_up boolean not null default false,
  created_at timestamptz not null default now(),
  last_used_at timestamptz null,
  revoked_at timestamptz null,
  revoked_reason text null,
  constraint app_auth_credentials_sign_count_non_negative check (sign_count >= 0)
);

create index if not exists app_auth_credentials_login_id_idx
  on public.app_auth_credentials (login_id);
create index if not exists app_auth_credentials_hr_id_idx
  on public.app_auth_credentials (hr_id);
create index if not exists app_auth_credentials_revoked_at_idx
  on public.app_auth_credentials (revoked_at);

comment on table public.app_auth_credentials is
  'WebAuthn/passkey public keys for biometric sign-in. Contains NO biometric data — the '
  'fingerprint/face never leaves the device. Revoke by setting revoked_at, never by deleting, '
  'so an audit can still explain how a past login succeeded.';

-- ---------------------------------------------------------------------------
-- One-time challenges. A challenge is issued, then consumed by exactly one verify call.
-- ---------------------------------------------------------------------------
create table if not exists public.app_auth_webauthn_challenges (
  id uuid primary key default gen_random_uuid(),
  challenge text not null unique,
  purpose text not null,
  -- NULL for sign-in: with discoverable credentials the browser tells us who it is only in the
  -- assertion, so at challenge-issue time we genuinely do not know yet. Set for enrollment,
  -- which always happens inside an authenticated session.
  login_id text null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint app_auth_webauthn_challenges_purpose_check
    check (purpose in ('registration', 'authentication'))
);

create index if not exists app_auth_webauthn_challenges_expires_at_idx
  on public.app_auth_webauthn_challenges (expires_at);

comment on table public.app_auth_webauthn_challenges is
  'Single-use WebAuthn challenges, deleted on consumption. Rows expire in ~2 minutes and are '
  'swept opportunistically on each insert — deliberately NOT cron-dependent, because the Cloud '
  'Scheduler cron jobs died with GCP on 2026-08-01 and a cron-cleaned table would grow forever.';

-- ---------------------------------------------------------------------------
-- Access control — identical shape to public.app_sessions.
-- ---------------------------------------------------------------------------
alter table public.app_auth_credentials enable row level security;
revoke all on table public.app_auth_credentials from anon, authenticated;
grant select, insert, update, delete on table public.app_auth_credentials to service_role;
drop policy if exists app_auth_credentials_service_role_all on public.app_auth_credentials;
create policy app_auth_credentials_service_role_all
  on public.app_auth_credentials
  for all
  to service_role
  using (true)
  with check (true);

alter table public.app_auth_webauthn_challenges enable row level security;
revoke all on table public.app_auth_webauthn_challenges from anon, authenticated;
grant select, insert, update, delete on table public.app_auth_webauthn_challenges to service_role;
drop policy if exists app_auth_webauthn_challenges_service_role_all on public.app_auth_webauthn_challenges;
create policy app_auth_webauthn_challenges_service_role_all
  on public.app_auth_webauthn_challenges
  for all
  to service_role
  using (true)
  with check (true);

notify pgrst, 'reload schema';

commit;
