-- prodplan_products_default_sample_units
--
-- WHAT THIS CHANGES: adds prodplan_products.default_sample_units — the free-sample count the
--   planner's Samples field starts at for that product — and sets it to 0 for Royanoxicam 8 mg.
--   Ivyronc and Guamusin keep 10,000, the figure the screen has always opened on.
-- WHY: the screen opened every product on Ivyronc's 10,000 samples. Royanoxicam is a film-coated
--   tablet with no free samples, so choosing a run count and pressing Calculate read "590,000
--   tablets and 10,000 samples" for 3 runs instead of 600,000 tablets (owner, 2026-10-24: "when we
--   chose the run counts in royanoxicam and press calculate" — confirmed as the 10,000 samples).
--   A per-product row rather than a constant on the screen: the module's rule is that nothing it
--   plans with is hard-coded.
-- ROLLBACK: alter table public.prodplan_products drop column default_sample_units;
--   (nothing else reads it; the screen falls back to 0 samples when the field is absent)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: one added column with a default, and one row updated.

begin;

alter table public.prodplan_products
  add column if not exists default_sample_units integer not null default 10000;

alter table public.prodplan_products
  drop constraint if exists prodplan_products_default_sample_units_check;
alter table public.prodplan_products
  add constraint prodplan_products_default_sample_units_check
  check (default_sample_units >= 0 and default_sample_units <= 100000000);

comment on column public.prodplan_products.default_sample_units is
  'The free-sample count the planner''s Samples field starts at for this product. 0 for a product that gives no samples (Royanoxicam).';

update public.prodplan_products
   set default_sample_units = 0,
       updated_at = now()
 where code = 'ROYANOXICAM';

commit;
