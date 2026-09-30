-- WHAT: Phoenix CRM Wave 2 — the customer identity store. Four tables that record which rows in
--       different systems are the SAME doctor or the SAME pharmacy: `customer_identity_masters`
--       (one real person or shop), `customer_identity_links` (one live link per source row),
--       `customer_identity_rulings` ("these two are NOT the same", kept for good, withdrawable),
--       and `customer_identity_events` (who did what, when).
--
-- WHY:  One doctor is held under a different id in Phoenix CRM, in the marketing venue register, on
--       a direct order and in the iReports360 mirror, so nothing in this system can currently say
--       "this is one person". Measured read-only on production 2026-09-29: 543 exact-name groups
--       spanning two or more lines (1,160 rows), 95 same-line groups held by different reps, and
--       374 further fuzzy pairs. The owner's ruling is that the SYSTEM ONLY SUGGESTS and the SUPER
--       ADMIN CONFIRMS — nothing links by itself — so these tables hold confirmed decisions and the
--       decisions NOT to link, never a guess.
--
--       🔴 NOTHING HERE IS EVER WRITTEN BACK. No `phoenix_crm_*`, `marketing_*`, `direct_order_*` or
--       `crm_*` row is touched by this feature, and no rep's board is fed from it. A link is an
--       annotation ABOUT those rows that lives entirely in this module, which is also why the
--       module sits outside `src/lib/phoenix-crm/` — the Phoenix CRM boundary test forbids that
--       module from reading marketing or direct-order tables at all.
--
--       🔴 SERVICE ROLE ONLY. RLS is enabled with NO policy, exactly as
--       `phoenix_crm_location_integrity` is: visibility in this app is application-scoped, so the
--       gate that matters is the `customer_identity` permission (Super Admin only) asserted in the
--       route. The RLS-with-no-policy pair is what stops anon or authenticated reaching the table
--       directly with the key that ships in the browser bundle.
--
-- ROLLBACK: `drop table public.customer_identity_events, public.customer_identity_rulings,
--       public.customer_identity_links, public.customer_identity_masters;` — expand-only, so
--       nothing existing changes and dropping these four restores the prior state exactly. No data
--       outside these tables is created, altered or deleted by this migration.

begin;

set local lock_timeout = '5s';

-- ── One real person, or one real shop ────────────────────────────────────────────────────────────
-- `kind` is the owner's own scoping ruling (2026-09-30): PM and AM customers are BOTH in scope, and
-- each is linked only with its own kind — an AM contact is never folded into a PM one, whatever the
-- names say. A pharmacy is its own kind again, because a pharmacy is not a contact.
create table if not exists public.customer_identity_masters (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('PM', 'AM', 'pharmacy')),
  display_name text not null,
  -- The folded key the suggestion engine grouped on, kept so a later pass can find this master
  -- again without re-deriving it from a display name a human may since have tidied.
  name_key text not null,
  created_at timestamptz not null default now(),
  created_by_hr_id text,
  updated_at timestamptz not null default now(),
  updated_by_hr_id text
);

create index if not exists customer_identity_masters_kind_name_key_idx
  on public.customer_identity_masters (kind, name_key);

-- ── One live link per source row ─────────────────────────────────────────────────────────────────
-- The unique constraint IS the rule: a given row in a given system belongs to at most one master at
-- a time. Re-pointing it is an update, never a second row, so "which master is this customer on"
-- can never come back with two answers.
create table if not exists public.customer_identity_links (
  id uuid primary key default gen_random_uuid(),
  master_id uuid not null references public.customer_identity_masters (id) on delete cascade,
  source text not null check (source in ('phoenix_crm', 'marketing', 'direct_order', 'ireports360')),
  source_id text not null,
  kind text not null check (kind in ('PM', 'AM', 'pharmacy')),
  -- Which evidence band the engine offered when a human confirmed this. Kept for the audit, never
  -- read as authority: the confirmation is the authority.
  band text not null check (band in ('fact', 'strong', 'likely', 'possible')),
  confirmed_at timestamptz not null default now(),
  confirmed_by_hr_id text not null,
  constraint customer_identity_links_one_per_source_row unique (source, source_id)
);

create index if not exists customer_identity_links_master_idx
  on public.customer_identity_links (master_id);

-- ── "These two are NOT the same" ─────────────────────────────────────────────────────────────────
-- Owner, 2026-09-30: a ruling is kept for good so the same pair is never offered again — AND the
-- Super Admin can undo it, at which point the pair returns as a suggestion and the undo is logged
-- with who and when. So a withdrawal is a column on the row, never a delete: the history of the
-- decision survives its reversal.
--
-- `pair_key` is the two sides ordered and joined, so (a, b) and (b, a) are ONE ruling rather than
-- two that disagree. The uniqueness is PARTIAL — only a live ruling is unique, so a withdrawn one
-- does not block the pair from being ruled on again later.
create table if not exists public.customer_identity_rulings (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('PM', 'AM', 'pharmacy')),
  left_source text not null,
  left_source_id text not null,
  right_source text not null,
  right_source_id text not null,
  pair_key text not null,
  reason text,
  ruled_at timestamptz not null default now(),
  ruled_by_hr_id text not null,
  withdrawn_at timestamptz,
  withdrawn_by_hr_id text
);

create unique index if not exists customer_identity_rulings_live_pair_idx
  on public.customer_identity_rulings (pair_key)
  where withdrawn_at is null;

create index if not exists customer_identity_rulings_kind_idx
  on public.customer_identity_rulings (kind, ruled_at desc);

-- ── Who did what ─────────────────────────────────────────────────────────────────────────────────
create table if not exists public.customer_identity_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_hr_id text,
  event text not null,
  master_id uuid,
  detail jsonb not null default '{}'::jsonb
);

create index if not exists customer_identity_events_at_idx
  on public.customer_identity_events (at desc);

-- ── Service role only ────────────────────────────────────────────────────────────────────────────
-- RLS on with NO policy denies every request that is not the service role, including one carrying
-- the publishable key. The revoke is written against `public` as well as the two roles, because
-- anon and authenticated inherit EXECUTE and SELECT through PUBLIC membership — revoking only the
-- two named roles is a no-op.
alter table public.customer_identity_masters enable row level security;
alter table public.customer_identity_links enable row level security;
alter table public.customer_identity_rulings enable row level security;
alter table public.customer_identity_events enable row level security;

revoke all on public.customer_identity_masters from public, anon, authenticated;
revoke all on public.customer_identity_links from public, anon, authenticated;
revoke all on public.customer_identity_rulings from public, anon, authenticated;
revoke all on public.customer_identity_events from public, anon, authenticated;

grant select, insert, update, delete on public.customer_identity_masters to service_role;
grant select, insert, update, delete on public.customer_identity_links to service_role;
grant select, insert, update, delete on public.customer_identity_rulings to service_role;
grant select, insert on public.customer_identity_events to service_role;

notify pgrst, 'reload schema';

commit;
