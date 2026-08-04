-- Direct Orders — pick the pharmacy from the distributor's own customer list, by NAME.
--
-- Owner decision (2026-08-04). A submitter registering a direct-order pharmacy had to TYPE the
-- distributor's customer code from memory. Nobody knows those codes, and a wrong one is not a
-- harmless typo: retail sales are matched on (distributor_code, customer_code), so an incorrect
-- code silently attributes another pharmacy's sales to this one on the screen where money is
-- approved. See memory/sos-client-code-is-not-unique-across-distributors.md.
--
-- Two changes, both additive.

begin;

-- ── 1. Make the scoped customer search an index seek ─────────────────────────
--
-- The picker filters by (distributor, region/area) and then matches a name fragment. Without
-- this index that plan is an index scan on (active, distributor_code) that throws away ~28,500
-- rows per keystroke — measured at 181ms and 22,500 buffers on production, far too slow to type
-- against. Carrying customer_name/code/brick in the INCLUDE keeps it a covering index, so the
-- name match happens on the few hundred rows that survive the scope filter rather than on 51k.
create index if not exists sos_customer_map_scope_search_idx
  on public.source_of_sales_customer_map (distributor_code, region_code, area_code)
  include (customer_code, customer_name, brick_id, address)
  where active;

-- ── 2. Pharmacy verification state ───────────────────────────────────────────
--
-- A pharmacy CHOSEN from the distributor's catalogue is verified by construction: its code came
-- from the distributor's own records. A pharmacy TYPED BY HAND is not — it may be genuinely new,
-- or it may be a wrong code that will silently mis-attribute sales.
--
-- The owner's rule holds either way: typing it never BLOCKS the request. It flags the pharmacy
-- for SFE review and a final Super-Admin acknowledgment instead.
--
-- Existing rows default to 'verified': they pre-date this feature and re-flagging live pharmacies
-- as suspect would raise a review queue nobody asked for, out of data that was never in question.
alter table public.direct_order_pharmacies
  add column if not exists verification_status text not null default 'verified'
    check (verification_status in ('verified', 'pending_review'));

alter table public.direct_order_pharmacies
  add column if not exists entry_source text not null default 'catalogue'
    check (entry_source in ('catalogue', 'manual'));

alter table public.direct_order_pharmacies
  add column if not exists verified_by_hr_id text;

alter table public.direct_order_pharmacies
  add column if not exists verified_at timestamptz;

-- The review queue is "everything still pending", so index exactly that and nothing else.
create index if not exists direct_order_pharmacies_pending_review_idx
  on public.direct_order_pharmacies (created_at desc)
  where verification_status = 'pending_review';

notify pgrst, 'reload schema';

commit;
