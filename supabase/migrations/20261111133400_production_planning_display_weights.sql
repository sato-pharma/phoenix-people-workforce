-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Production Planner — the batch weight and the tablet weight a product SHOWS, apart from the
-- integer geometry the engine counts with.
--
-- WHAT THIS CHANGES: adds two nullable columns to `prodplan_products`:
--   batch_weight_display  — one batch's weight in the LARGE unit (kg), as the factory states it
--   unit_weight_display   — one saleable unit's weight in the SMALL unit (mg), as the paper states it
-- Both are NULL for every existing product, which keeps every screen exactly as it is today.
--
-- WHY: owner, 2026-11-11, forwarding Sato's request for Royafloxacin 500 at Medizen: "80,000 tablets
-- … total tablet weight 845.6 mg … batch size equivalent 70 kg", then choosing, as a multiple choice,
-- "847.6 mg, 70 kg as stated" (Medizen's own paper adds to 847.6 mg; the email's 845.6 is the typo).
-- The engine counts tablets as `run_volume_ml / dose_ml`, and both are INTEGERS with
-- `run_volume_ml % dose_ml = 0` behind them, so a 847.6 mg tablet cannot be stored, and 80,000 of them
-- are 67.808 kg, not 70. The count stays on the integer geometry (80,000 tablets at the 815 mg core);
-- these two columns carry the figures he reads. They change no quantity anywhere: every formula line
-- is per tablet or per box, never per kilogram of batch.
--
-- ROLLBACK:
--   alter table public.prodplan_products drop column batch_weight_display;
--   alter table public.prodplan_products drop column unit_weight_display;
-- (Only after the code that selects them is gone — PostgREST fails the whole read on a missing column.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This is neither destructive nor bulk: two nullable columns, no row written.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

alter table public.prodplan_products
  add column if not exists batch_weight_display numeric(14, 4) null,
  add column if not exists unit_weight_display numeric(14, 4) null;

alter table public.prodplan_products
  drop constraint if exists prodplan_products_batch_weight_display_check,
  add constraint prodplan_products_batch_weight_display_check
    check (batch_weight_display is null or (batch_weight_display > 0 and batch_weight_display <= 1000000));

alter table public.prodplan_products
  drop constraint if exists prodplan_products_unit_weight_display_check,
  add constraint prodplan_products_unit_weight_display_check
    check (unit_weight_display is null or (unit_weight_display > 0 and unit_weight_display <= 1000000));

comment on column public.prodplan_products.batch_weight_display is
  'One batch''s weight as the factory states it, in the large unit (kg). Shown on the batch tile and in the sentence instead of run_volume_ml; never used to count. NULL shows run_volume_ml.';
comment on column public.prodplan_products.unit_weight_display is
  'One saleable unit''s weight as the paper states it, in the small unit (mg). Shown instead of dose_ml; never used to count. NULL shows dose_ml.';
