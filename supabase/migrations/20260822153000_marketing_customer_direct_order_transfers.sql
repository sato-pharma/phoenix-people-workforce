-- ─────────────────────────────────────────────────────────────────────────────
-- Marketing customer → Direct Order transfer ledger.
--
-- The owner's rule (2026-08-22): a manager validates a customer ONCE, in whichever module he is
-- standing in. He must not re-do the same field work in the other one. So an admin reviews the
-- validated marketing customer, and — when he is satisfied the record is full — hands it to
-- Direct Orders to be validated there, WITHOUT the rep or the manager capturing anything again.
--
-- This table is the ledger of that hand-off. It exists for three reasons, and only the first is
-- obvious:
--
--   1. REVERT. The owner asked for the transfer to be undoable ("if I notice anything, I can
--      revert this transfer"). Undo needs to know exactly what the transfer created, which is
--      more than one row in more than one table.
--   2. IDEMPOTENCE. Without it, pressing Transfer twice mints a second Direct Order pharmacy for
--      the same shop — the precise duplicate problem this whole feature is meant to reduce. The
--      partial unique index below makes a second live transfer impossible at the database level,
--      not merely discouraged in the route handler.
--   3. PROVENANCE. A Direct Order pharmacy that arrived by transfer did NOT come from the
--      distributor master sheets, and the desk deciding it should be able to see that, along with
--      who sent it and when.
--
-- Nothing here is destructive on revert: see the service. A reverted transfer keeps its row, keeps
-- its timestamps, and keeps naming the admin on both sides of the decision.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.marketing_customer_direct_order_transfers (
  id uuid primary key default gen_random_uuid(),

  -- What was sent.
  customer_id uuid not null
    references public.marketing_customers (id) on delete cascade,
  -- The marketing pharmacy carried across with the customer. Nullable because the link table is
  -- the authority for which pharmacy belongs to a customer, and a customer with none is a legal
  -- (if untransferable) shape — recording NULL is more honest than inventing a pharmacy.
  marketing_pharmacy_id uuid
    references public.marketing_pharmacies (id) on delete set null,

  -- What it became on the Direct Order side.
  direct_order_pharmacy_id uuid
    references public.direct_order_pharmacies (id) on delete set null,
  direct_order_validation_id uuid
    references public.direct_order_pharmacy_validations (id) on delete set null,

  -- 'transferred' while it is live on the Direct Order desk; 'reverted' once the admin pulls it
  -- back. There is deliberately no 'completed' state: once Direct Orders DECIDES the validation,
  -- that decision is theirs and this ledger stops being the authority on it.
  status text not null default 'transferred'
    check (status in ('transferred', 'reverted')),

  -- Whether the Direct Order pharmacy row was minted BY this transfer, or already existed and was
  -- merely reused. Revert may only deactivate a pharmacy this transfer actually created — undoing
  -- a hand-off must never retire a shop that Direct Orders knew about independently.
  created_direct_order_pharmacy boolean not null default false,

  transferred_by_hr_id text not null,
  transferred_at timestamptz not null default now(),
  transfer_notes text,

  reverted_by_hr_id text,
  reverted_at timestamptz,
  revert_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A reverted row must carry who reverted it and when; a live one must carry neither. Keeps the
  -- two states from blurring into "sort of reverted", which is what makes an undo untrustworthy.
  constraint marketing_customer_do_transfer_revert_complete check (
    (status = 'transferred' and reverted_by_hr_id is null and reverted_at is null)
    or
    (status = 'reverted' and reverted_by_hr_id is not null and reverted_at is not null)
  )
);

comment on table public.marketing_customer_direct_order_transfers is
  'Ledger of marketing customers handed to Direct Orders for validation by an admin, so the rep and manager never validate the same shop twice. One live transfer per customer; revert is recorded, never deleted.';

-- THE integrity rule. A customer may have many transfers over its life, but only ever ONE that is
-- currently live. Reverted rows are excluded, so an admin who reverts can transfer again later.
create unique index if not exists marketing_customer_do_transfer_one_live_per_customer
  on public.marketing_customer_direct_order_transfers (customer_id)
  where status = 'transferred';

create index if not exists marketing_customer_do_transfer_customer_idx
  on public.marketing_customer_direct_order_transfers (customer_id);

create index if not exists marketing_customer_do_transfer_pharmacy_idx
  on public.marketing_customer_direct_order_transfers (direct_order_pharmacy_id)
  where direct_order_pharmacy_id is not null;

-- The list page reads "who transferred what, most recent first".
create index if not exists marketing_customer_do_transfer_recent_idx
  on public.marketing_customer_direct_order_transfers (transferred_at desc);

-- ── updated_at ───────────────────────────────────────────────────────────────
-- Same trigger idiom the rest of the marketing tables use.
create or replace function public.marketing_customer_do_transfer_touch_updated_at()
returns trigger
language plpgsql
-- PARALLEL SAFE is a correctness declaration here, not a performance hint: a trigger function left
-- UNSAFE by default can force a serial plan onto any query that touches the table.
parallel safe
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists marketing_customer_do_transfer_touch_updated_at
  on public.marketing_customer_direct_order_transfers;

create trigger marketing_customer_do_transfer_touch_updated_at
  before update on public.marketing_customer_direct_order_transfers
  for each row
  execute function public.marketing_customer_do_transfer_touch_updated_at();

-- ── Access ───────────────────────────────────────────────────────────────────
-- Visibility in this application is APPLICATION-scoped: every read path here runs through the
-- service-role client after assertMarketingValidatedCustomerAdminAccess(). RLS is enabled with no
-- policy so that a browser-held anon/authenticated key can never reach the table directly — the
-- same posture the other marketing tables take, and the reason an ad-hoc backup table being
-- anon-readable was a real incident in this repo.
alter table public.marketing_customer_direct_order_transfers enable row level security;

revoke all on public.marketing_customer_direct_order_transfers from anon, authenticated;

-- ── Provenance on the Direct Order side ──────────────────────────────────────
-- `direct_order_pharmacies.entry_source` admitted exactly two values: 'catalogue' (materialized
-- from the distributor master sheets) and 'manual' (typed in by a rep against a held order). A
-- transferred marketing customer is neither, and calling it 'manual' would be a small lie with a
-- real cost: the Direct Order desk's FIRST job on a validation is to decide whether the shop
-- already exists under another spelling, and "this arrived from marketing, already photographed
-- at a GPS fix, already validated by its manager" is exactly the context that decision needs.
--
-- Widening a CHECK is additive and cannot invalidate an existing row: every current row is
-- 'catalogue' or 'manual' (verified against production, 40 rows, before this migration was
-- written), and both remain legal.
alter table public.direct_order_pharmacies
  drop constraint if exists direct_order_pharmacies_entry_source_check;

alter table public.direct_order_pharmacies
  add constraint direct_order_pharmacies_entry_source_check
  check (entry_source = any (array['catalogue'::text, 'manual'::text, 'marketing_transfer'::text]));
