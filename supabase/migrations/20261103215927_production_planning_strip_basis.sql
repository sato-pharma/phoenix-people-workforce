-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Production Planner — a formula line counted by the blister strip.
--
-- WHAT THIS CHANGES: adds `prodplan_products.strips_per_box`, empty for every existing product, and
-- widens the two basis CHECKs by one value, `per_strip`. No row is changed.
--
-- WHY: owner, 2026-11-03: Saginkgo's foil is "0.002285 aluminum quaty per box and the box is 3 شرايط
-- sample is one so divide by 3". One formula row can only be per box or per sample, so the foil is
-- counted by the strip: 3 a saleable box and 1 a sample box.
--
-- 🔴 APPLY THIS ONE BEFORE THE MERGE. The code selects the new column, and PostgREST fails the whole
-- read when a named column is missing, so the planner would go blank without it. Saginkgo's own rows
-- are in the next file, which goes on AFTER the code is live.
--
-- ROLLBACK: additive. After the code that reads it is gone and no row uses `per_strip`:
--   alter table public.prodplan_products drop column strips_per_box;
-- and narrow both CHECKs back to the five older values.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: one nullable column, and two CHECKs widened, never narrowed.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

begin;

alter table public.prodplan_products
  add column if not exists strips_per_box integer;

alter table public.prodplan_products
  drop constraint if exists prodplan_products_strips_per_box_check;

alter table public.prodplan_products
  add constraint prodplan_products_strips_per_box_check
  check (strips_per_box is null or strips_per_box between 1 and 1000);

comment on column public.prodplan_products.strips_per_box is
  'Blister strips in one saleable box: 3 for Saginkgo. Empty means the product does not count strips, and a per_strip formula line cannot be saved on it.';

alter table public.prodplan_compositions
  drop constraint if exists prodplan_compositions_basis_check;

alter table public.prodplan_compositions
  add constraint prodplan_compositions_basis_check
  check (basis = any (array[
    'per_dose'::text,
    'per_packaging_set'::text,
    'per_good_unit'::text,
    'per_sample_unit'::text,
    'per_box'::text,
    'per_strip'::text
  ]));

alter table public.prodplan_plan_lines
  drop constraint if exists prodplan_plan_lines_basis_check;

alter table public.prodplan_plan_lines
  add constraint prodplan_plan_lines_basis_check
  check (snap_basis = any (array[
    'per_dose'::text,
    'per_packaging_set'::text,
    'per_good_unit'::text,
    'per_sample_unit'::text,
    'per_box'::text,
    'per_strip'::text
  ]));

commit;

-- Timestamp 20261103215927 was minted to sort after every migration already on main.
