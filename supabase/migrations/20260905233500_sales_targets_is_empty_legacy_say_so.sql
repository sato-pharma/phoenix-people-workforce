-- public.sales_targets / public.sales_target_batches are EMPTY LEGACY. Label them in the database.
--
-- Measured on production (ozucdzovmcqvepbozvqf) 2026-09-05: both hold ZERO rows, and have never
-- held any. The live sales targets are au.monthly_targets -- 3,808 rows across 2026-01, 2026-02,
-- 2026-07, 2026-08 and 2026-09, over 3 lines and 39 areas.
--
-- WHY A COMMENT IS WORTH A MIGRATION. These two carry the obvious name in the obvious schema and
-- answer a SELECT confidently with zero rows. A session asking "do we have sales targets?" against
-- public.sales_targets gets a clean, authoritative, WRONG "no" -- which is exactly what happened
-- on 2026-09-05 during a system tour. AGENTS.md 1.2 ("verify against live reality") does not save
-- you here, because the wrong table IS live reality; it is just not the one that holds the data.
-- A table COMMENT shows in \d+, in the Supabase table editor and in every schema browser, so it
-- lands in front of the reader at the moment they are looking at the wrong table.
--
-- WHY NOT DROP THEM. Dropping is destructive and production has no PITR (7 daily physical backups,
-- granularity one day, restore unit is the whole database). It was put to the owner on 2026-09-05
-- and he chose the comment. Note that supabase/20260509_drop_sales_target_flow.sql already drops
-- both -- it is a loose root script, never stamped into supabase/migrations/, and provably never
-- applied. Reviving it is the follow-up, not this change.
--
-- Nothing depends on these tables: no view, no matview, no trigger, and the only foreign key is
-- internal (sales_targets.batch_id -> sales_target_batches.id). Nothing in the repository READS
-- them. The one live code path that touches them writes: the manager-reassignment cascade in
-- src/lib/employees/employee-directory.ts PATCHes sales_targets, matching zero rows, and
-- tests/manager-cascade-frozen-tables.test.ts pins that write in the required CI `validate` check.
--
-- Idempotent and reversible: `comment on table ... is null` removes it.

comment on table public.sales_targets is
  'EMPTY LEGACY -- DO NOT READ. Zero rows, ever. The live sales targets are au.monthly_targets, '
  'read through the service-role RPCs phx_monthly_targets / phx_upsert_monthly_targets (the au '
  'schema is not PostgREST-exposed). This table still exists only because the manager-reassignment '
  'cascade PATCHes it and a required CI test pins that write. See src/lib/sales/monthly-targets.ts.';

comment on table public.sales_target_batches is
  'EMPTY LEGACY -- DO NOT READ. Zero rows, ever. Batch header for the retired public.sales_targets '
  'upload flow. The live sales targets are au.monthly_targets, read through the service-role RPCs '
  'phx_monthly_targets / phx_upsert_monthly_targets. See src/lib/sales/monthly-targets.ts.';
