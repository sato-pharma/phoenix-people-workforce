-- ─────────────────────────────────────────────────────────────────────────────
-- Weekly Sales — week-of-month tagging (Phase 1 of the cumulative-fix build).
--
-- ⚠️ IMPORTANT SCOPE GUARDRAIL (owner-mandated 2026-06-28):
--   This migration touches ONLY the Weekly Sales module tables
--   (public.weekly_sales_batches, public.weekly_sales_rows).
--   It MUST NOT touch any other sales module — NOT source_of_sales_* (monthly),
--   NOT the analytics.* views, NOT sales-intelligence / ROI / command-center, NOT
--   any RPC outside weekly sales. Additive only: no drops, no rewrites of existing
--   columns, no changes to existing constraints/indexes.
--
-- WHY: every distributor's weekly sheet is CUMULATIVE from the start of its month
--   (e.g. "12-May" = sales of 1→12 May, not 6→12). To compute true per-week sales
--   the dashboard must know, for each upload, which month-cycle and which week (1–4)
--   it belongs to. This migration adds those two tags and backfills them from each
--   row's existing week_start date. De-cumulation itself is done at READ TIME in a
--   later phase; nothing about how data is stored/parsed changes here.
--
-- BACKFILL RULE (matches the upload wizard's "auto from the sheet date" default):
--   cycle_month = first day of week_start's calendar month.
--   week_number = day-of-month bucket, capped at 4:
--     day 1–7 → 1, 8–14 → 2, 15–21 → 3, 22+ → 4.
--   Boundary sheets dated on the 1st–3rd that actually close the PRIOR month, and
--   any week that later de-cumulates negative, are surfaced for manual re-tagging
--   (see the Phase-1 dry-run report) — NOT auto-corrected here.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Columns (nullable; week_start itself is nullable so the tags can be too).
alter table public.weekly_sales_batches
  add column if not exists cycle_month date,
  add column if not exists week_number smallint;

alter table public.weekly_sales_rows
  add column if not exists cycle_month date,
  add column if not exists week_number smallint;

-- 2. Guard rails on the week number (allow NULL for untagged / no-date rows).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'weekly_sales_batches_week_number_chk'
  ) then
    alter table public.weekly_sales_batches
      add constraint weekly_sales_batches_week_number_chk
      check (week_number is null or week_number between 1 and 4);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'weekly_sales_rows_week_number_chk'
  ) then
    alter table public.weekly_sales_rows
      add constraint weekly_sales_rows_week_number_chk
      check (week_number is null or week_number between 1 and 4);
  end if;
end $$;

-- 3. Backfill batch tags from week_start (only where not already set, so a manual
--    re-tag is never overwritten by re-running this migration).
update public.weekly_sales_batches
set
  cycle_month = date_trunc('month', week_start)::date,
  week_number = case
    when extract(day from week_start) <= 7 then 1
    when extract(day from week_start) <= 14 then 2
    when extract(day from week_start) <= 21 then 3
    else 4
  end
where week_start is not null
  and cycle_month is null;

-- 4. Backfill row tags from their parent batch (one batch = one uploaded sheet =
--    one week, so all its rows share the same tags). Sourced from the batch, not
--    the row's own week_start, which can be null on multi-date uploads.
update public.weekly_sales_rows r
set
  cycle_month = b.cycle_month,
  week_number = b.week_number
from public.weekly_sales_batches b
where r.batch_id = b.id
  and r.cycle_month is null
  and b.cycle_month is not null;

-- 5. Indexes to make the de-cumulation reads (per distributor per month, ordered
--    by date) and the new Week filter fast.
create index if not exists weekly_sales_batches_cycle_idx
  on public.weekly_sales_batches (distributor_code, cycle_month, week_number);
create index if not exists weekly_sales_rows_cycle_idx
  on public.weekly_sales_rows (distributor_code, cycle_month, week_number);

comment on column public.weekly_sales_batches.cycle_month is
  'First day of the month-cycle this cumulative sheet belongs to (backfilled from week_start; owner-confirmable on upload).';
comment on column public.weekly_sales_batches.week_number is
  'Week-of-month 1–4 (day-of-month bucket, capped at 4). Drives de-cumulation pairing and the dashboard Week filter.';
comment on column public.weekly_sales_rows.cycle_month is
  'Mirror of the parent batch cycle_month (for fast per-month de-cumulation + Week filtering on rows).';
comment on column public.weekly_sales_rows.week_number is
  'Mirror of the parent batch week_number (1–4).';
