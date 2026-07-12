-- IP blocklist for the login path. A Super Admin can block an IP from the System Issues
-- security lens (e.g. a credential-stuffing source); the login route rejects blocked IPs
-- with the same generic "too many attempts" response, before verifying credentials.
--
-- Safety by design:
--   * expires_at makes every block time-bound by default, so a mistaken block or a shared/
--     reassigned (NAT) IP can never lock legitimate users out forever. NULL = permanent.
--   * Enforcement is fail-open in code: if this table is unreachable, login is NOT blocked.
--   * Service-role only (RLS enabled, no policies) — never exposed to browser roles.

begin;

create table if not exists public.blocked_ips (
  id uuid primary key default gen_random_uuid(),
  ip text not null unique,
  reason text check (reason is null or char_length(reason) <= 500),
  blocked_by text,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

-- Enforcement lookup: "is this ip currently blocked" — ip equality plus an active-window
-- check (expires_at is null or in the future).
create index if not exists idx_blocked_ips_expires_at on public.blocked_ips (expires_at);

alter table public.blocked_ips enable row level security;

notify pgrst, 'reload schema';

commit;
