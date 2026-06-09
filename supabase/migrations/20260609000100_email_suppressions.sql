-- Durable email suppression list.
--
-- Suppression was previously recomputed on every send by scanning the entire
-- email_delivery_events log filtered only by status (no recipient predicate, unbounded
-- growth, the recipients GIN index unused). This table is the source of truth for
-- "do not email this address", populated by the Resend webhook (hard bounce / complaint)
-- and by the one-click unsubscribe endpoint. Send-time lookups are O(1) on the address PK.
--
--  reason:
--    hard_bounce  - permanent bounce (mailbox does not exist) → suppress (optionally with
--                   an expiry for soft/transient bounces so they auto-recover)
--    complaint    - recipient marked spam → suppress PERMANENTLY (fail-closed)
--    unsubscribe  - recipient used List-Unsubscribe one-click
--    manual       - admin-added
--  expires_at: null = permanent; a future timestamp = auto-recovers (soft bounces).

begin;

create table if not exists public.email_suppressions (
  address text primary key,
  reason text not null check (reason in ('hard_bounce', 'complaint', 'unsubscribe', 'manual')),
  source text not null,
  bounce_subtype text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz null
);

-- Active suppressions (no expiry, or not yet expired).
create index if not exists email_suppressions_active_idx
  on public.email_suppressions (address)
  where expires_at is null or expires_at > now();

-- Service-role only: this list is written by server webhooks/endpoints and read by the
-- send layer. No anon/authenticated access.
alter table public.email_suppressions enable row level security;
revoke all on public.email_suppressions from anon, authenticated;
grant all on public.email_suppressions to service_role;

notify pgrst, 'reload schema';

commit;
