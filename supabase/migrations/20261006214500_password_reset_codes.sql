-- WHAT   One row per self-service password-reset code: the short, single-use 6-digit code an
--        employee is emailed when they ask to set a new password from the Sato email they typed on
--        the login page, plus the attempt counter and expiry that make a 6-digit secret safe.
--
-- WHY    Until now a password could only be set or reset from an ADMIN-generated one-time LINK
--        (password_setup_tokens, 48h). Employees did not open the links (spam, expiry), so the
--        owner asked for a self-service path: type the Sato email -> receive a code -> enter it ->
--        set the password, all on the login page, no admin and no link to hunt for.
--
--        A 6-digit code is only 1,000,000 combinations, so it is safe ONLY with a tight attempt cap
--        and a short life: this table carries both (max_attempts, expires_at), and the server locks
--        the code after `max_attempts` wrong tries and refuses it past `expires_at`. The code itself
--        is never stored — only an HMAC of (login_id + code) keyed on the app auth secret, so a leak
--        of this table cannot be brute-forced offline into the live codes. On a correct code the
--        server mints a normal short-lived password_setup_tokens row and the existing
--        /password-setup/[token] flow sets the password (bcrypt, session bump, Supabase bridge,
--        audit) — this table adds the email-proof step in front of that, nothing more.
--
--        Written by the server and read by nobody below the service role: RLS on with a service-role
--        policy and the browser roles revoked, exactly as password_setup_tokens and the Phoenix CRM
--        integrity tables are.
--
-- ROLLBACK
--        drop table if exists public.password_reset_codes;
--        Additive in full: no existing table, column, view, function, policy or grant is touched, so
--        dropping it only ends the self-service code path (admin link reset still works). Nothing
--        reads it except src/lib/auth/password-setup.ts, so no screen breaks.

begin;
set local lock_timeout = '5s';

create table if not exists public.password_reset_codes (
  id uuid primary key default gen_random_uuid(),
  -- The app_auth_users.login_id the code was minted for, resolved server-side from whatever the
  -- person typed (HR_ID, login ID, or Sato work email) — never the raw thing they typed.
  login_id text not null,
  -- HMAC-SHA256(PHOENIX_AUTH_SECRET, login_id || ':' || code). The code is never stored in the clear
  -- and the HMAC key is not in this database, so a dump of this table cannot be reversed to the code.
  code_hash text not null,
  -- Wrong tries so far, and the ceiling. The server increments attempts on every mismatch and treats
  -- the code as dead once attempts >= max_attempts — this is what makes a 6-digit secret safe.
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  expires_at timestamptz not null,
  -- Set the instant the code is accepted (or superseded by a newer request): a consumed row can
  -- never be used again, and only the newest unconsumed row for a login is ever live.
  consumed_at timestamptz,
  -- The caller's IP, kept for abuse review only. Nullable: a proxy or a missing header must never
  -- cost the row.
  request_ip text,
  -- The mailbox the code was actually sent to (employees.work_email / app_auth_users.email). Kept so
  -- a "no code arrived" question is answerable without re-deriving the recipient.
  sent_to_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.password_reset_codes is
  'Self-service password-reset 6-digit codes (HMAC-hashed), with attempt cap and expiry. Service role only; no browser-facing screen reads it. See src/lib/auth/password-setup.ts.';

-- "What codes were minted for this login, newest first" (the only read the verify path does) and a
-- cheap sweep of what is still live.
create index if not exists password_reset_codes_login_idx
  on public.password_reset_codes (login_id, created_at desc);
create index if not exists password_reset_codes_active_idx
  on public.password_reset_codes (login_id, expires_at) where (consumed_at is null);

-- Service-role only, exactly like password_setup_tokens: the app reaches this table solely through
-- getSupabaseAdmin(), and no anon/authenticated/browser role may read or write it.
alter table public.password_reset_codes enable row level security;
create policy password_reset_codes_service_role
  on public.password_reset_codes for all to service_role using (true) with check (true);
revoke all on table public.password_reset_codes from public, anon, authenticated;
grant all on table public.password_reset_codes to service_role;

notify pgrst, 'reload schema';

commit;
