-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Production Planner — the schema Saginkgo needs: a sample that is its own box, and the capsule unit.
--
-- WHAT THIS CHANGES: adds `prodplan_products.sample_in_own_box`, false for every existing product, and
-- widens the measure_unit CHECK by one value, `mg_capsule`. No row is changed.
--
-- WHY: owner, 2026-11-03: Saginkgo's free sample is one box holding one strip of five capsules
-- ("بوكس شريط واحد فيه خمسة"). The engine counts a sample as one more saleable unit, so at 30 capsules
-- a box it read as a thirtieth of a box. Every existing product keeps that reading.
--
-- 🔴 APPLY THIS ONE BEFORE THE MERGE. The code selects the new column, and PostgREST fails the whole
-- read when a named column is missing, so the planner would go blank without it. Saginkgo's own rows
-- are in the next file, which goes on AFTER the code is live.
--
-- ROLLBACK: additive. After the code that reads it is gone:
--   alter table public.prodplan_products drop column sample_in_own_box;
-- The CHECK may be narrowed back to ml, g and mg once no row uses `mg_capsule`.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: one column with a default, and a CHECK widened, never narrowed.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

begin;

alter table public.prodplan_products
  add column if not exists sample_in_own_box boolean not null default false;

comment on column public.prodplan_products.sample_in_own_box is
  'True when one free sample is a whole box of its own holding sample_unit_ml of product, as Saginkgo''s box of one 5-capsule strip is. False counts a sample as one more saleable unit, the rule for every older product.';

alter table public.prodplan_products
  drop constraint if exists prodplan_products_measure_unit_check;

alter table public.prodplan_products
  add constraint prodplan_products_measure_unit_check
  check (measure_unit = any (array['ml'::text, 'g'::text, 'mg'::text, 'mg_capsule'::text]));

commit;
