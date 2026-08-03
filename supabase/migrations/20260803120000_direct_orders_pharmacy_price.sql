-- Direct Orders — bonus deals price on the PHARMACY price, not the factory price.
--
-- Owner decision (2026-08-03): a bonus direct order's sales value becomes
--   qty × pharmacy_price  (was: qty × factory_price)
-- Discount deals are UNCHANGED — they keep pricing on public_price:
--   qty × public_price × (1 − discount_pct/100)
--
-- Both columns are deliberately left NULL rather than seeded to factory_price. NULL is the
-- only value that distinguishes "the owner has not set this yet" from "the owner deliberately
-- set it equal to the factory price". Seeding would be numerically identical (submitDirectOrder
-- falls back to the factory price when there is no pharmacy price) but would permanently destroy
-- the signal that the admin price table, the missing-price flag, and the historical backfill's
-- coverage check all read. A zero is normalized to NULL by the setter for the same reason.
--
-- On deploy this migration changes NO number: every product starts with a NULL pharmacy price,
-- so every bonus order falls back to the factory price and prices exactly as it does today.

begin;

-- ── Pharmacy price on the product master (sibling of public_price) ────────────
alter table public.source_of_sales_products
  add column if not exists pharmacy_price numeric(18,6);

-- ── Per-request snapshot of the basis that was actually used ─────────────────
-- NULL on a bonus request means the value fell back to factory_price_snapshot. That makes the
-- row self-describing forever after: the flag stays true about how THIS row's sales_value was
-- computed even once the product later gets a pharmacy price.
alter table public.direct_order_requests
  add column if not exists pharmacy_price_snapshot numeric(18,6)
    check (pharmacy_price_snapshot is null or pharmacy_price_snapshot >= 0);

notify pgrst, 'reload schema';

commit;
