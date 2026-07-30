begin;

-- ---------------------------------------------------------------------------
-- 1. source_of_sales_block_groups was leaking its base tables to anon
-- ---------------------------------------------------------------------------
-- 20260728190000_sos_block_grouping.sql created this view with a plain
-- `create or replace view`, which defaults to SECURITY DEFINER semantics — the view runs as its
-- owner (postgres), not as the caller. Its four base tables are correctly locked down
-- (source_of_sales_blocks / _areas / _bricks: RLS on, no anon SELECT; _customer_map: RLS on with
-- zero policies = deny-all), so the view was the ONLY path by which that data reached anon.
-- Confirmed live: GET /rest/v1/source_of_sales_block_groups returned HTTP 206, 154 rows.
--
-- Nothing in the application reads this view — the app reads Source-of-Sales exclusively through
-- getSupabaseAdmin() (service role), which is unaffected by security_invoker. So switching to
-- invoker semantics closes the hole with no functional blast radius.
do $$
begin
  if to_regclass('public.source_of_sales_block_groups') is not null then
    alter view public.source_of_sales_block_groups set (security_invoker = true);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Pin the two remaining mutable search_paths
-- ---------------------------------------------------------------------------
-- sos_backup_20260728.restore_all() is SECURITY DEFINER and issues unqualified
-- `delete from source_of_sales_*` against six live tables. With a mutable search_path a caller
-- could resolve those names to their own objects while the function runs as the owner. The pin
-- below is exactly what it resolves to today (unqualified names -> public, plus its own schema
-- for the qualified sos_backup_20260728.* reads), so behaviour is unchanged.
do $$
begin
  if to_regprocedure('sos_backup_20260728.restore_all()') is not null then
    alter function sos_backup_20260728.restore_all() set search_path = public, sos_backup_20260728;
  end if;

  -- Trigger function, SECURITY INVOKER — lower risk, pinned for consistency with every other
  -- public trigger function in this schema.
  if to_regprocedure('public.phx_assert_master_brick_in_block()') is not null then
    alter function public.phx_assert_master_brick_in_block() set search_path = public;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Covering indexes for the 7 foreign keys flagged since the 2026-07-19 sweep
-- ---------------------------------------------------------------------------
-- Same treatment the earlier advisor sweeps gave their FK gaps: purely additive, no data change.
create index if not exists ats_candidate_cv_extractions_file_id_idx
  on public.ats_candidate_cv_extractions (file_id);
create index if not exists ats_cv_intake_events_file_id_idx
  on public.ats_cv_intake_events (file_id);
create index if not exists automated_payroll_runs_published_batch_id_idx
  on public.automated_payroll_runs (published_batch_id);
create index if not exists ireports360_crm_customer_brick_resolutions_brick_id_idx
  on public.ireports360_crm_customer_brick_resolutions (brick_id);
create index if not exists ireports360_crm_region_brick_resolutions_brick_id_idx
  on public.ireports360_crm_region_brick_resolutions (brick_id);
create index if not exists private_calendar_no_activity_clarif_deduction_candidate_id_idx
  on public.private_calendar_no_activity_clarifications (deduction_candidate_id);
create index if not exists source_of_sales_blocks_master_brick_id_idx
  on public.source_of_sales_blocks (master_brick_id);

commit;
