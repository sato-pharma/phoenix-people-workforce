-- marketing_pharmacy_direct_order_venues
--
-- WHAT THIS CHANGES: a new link table, one row per marketing pharmacy, naming the Direct Order venue
-- that pharmacy IS. Written by the automatic hand-over (src/lib/marketing-requests/direct-order-venue-sync.ts)
-- and by the Super Admin's manual Transfer; read by "My venues" and by the direct-order approval
-- panel, which shows the marketing pharmacy and customer photos for the venue an order stands on.
-- Seeded from the four live manual transfers so the hand-over never mints those shops twice.
--
-- WHY: owner, 2026-10-21 — a customer a rep validates for marketing requests is validated in his
-- Direct Orders too, appears in his venues, and its validation photos reach every approver. Until
-- now the two modules shared no key: only a Super Admin's Transfer click crossed the gap (4 of 93
-- validated customers), and only for the customer's first pharmacy.
--
-- ROLLBACK: drop table public.marketing_pharmacy_direct_order_venues;  -- the venues it pointed at
-- stay in direct_order_pharmacies; only the link is lost.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create table if not exists public.marketing_pharmacy_direct_order_venues (
  marketing_pharmacy_id uuid primary key
    references public.marketing_pharmacies(id) on delete cascade,
  direct_order_pharmacy_id uuid not null
    references public.direct_order_pharmacies(id) on delete cascade,
  -- created: the hand-over minted the venue; reused: a Direct Order venue already held the
  -- pharmacy's registered distributor code; transferred: the Super Admin's manual Transfer.
  link_kind text not null check (link_kind in ('created', 'reused', 'transferred')),
  -- The validated customer whose capture brought the pharmacy across (the audit trail, not the
  -- owner — "My venues" is answered from every validated link on the pharmacy at read time).
  customer_id uuid references public.marketing_customers(id) on delete set null,
  linked_at timestamptz not null default now()
);

create index if not exists marketing_pharmacy_direct_order_venues_venue_idx
  on public.marketing_pharmacy_direct_order_venues (direct_order_pharmacy_id);

alter table public.marketing_pharmacy_direct_order_venues enable row level security;
-- Server-only: the service-role client reads and writes it. No browser role is granted anything.
revoke all on table public.marketing_pharmacy_direct_order_venues from anon, authenticated;

insert into public.marketing_pharmacy_direct_order_venues
  (marketing_pharmacy_id, direct_order_pharmacy_id, link_kind, customer_id, linked_at)
select distinct on (t.marketing_pharmacy_id)
  t.marketing_pharmacy_id, t.direct_order_pharmacy_id, 'transferred', t.customer_id, t.transferred_at
from public.marketing_customer_direct_order_transfers t
where t.status = 'transferred'
  and t.marketing_pharmacy_id is not null
  and t.direct_order_pharmacy_id is not null
order by t.marketing_pharmacy_id, t.transferred_at asc
on conflict (marketing_pharmacy_id) do nothing;

commit;
