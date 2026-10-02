-- roi_sales_data_asof_every_month_set
--
-- WHAT THIS CHANGES: `phx_marketing_roi_latest_validated_period()` stops answering "the newest
--   period any validated batch mentions" and answers "the newest period that is actually LOADED" —
--   one where every distributor that files every month has filed.
-- WHY: the old answer is the ROI tracker's completeness flag, and on 2026-10-02 it read 2026-09 on
--   the strength of ONE batch out of eighteen (41 rows against ~44,500 in August). That flipped
--   three campaigns from "waiting for the data" to a verdict of NO SALES, and printed "sales loaded
--   through 2026-09" on a report where September is not loaded at all. Measured the same day: the
--   every-month set is 12 distributors, present 12/12 in every month 2026-01..2026-08 and 0/12 in
--   2026-09, so the new definition answers 2026-08 — which is the truth.
-- ROLLBACK: re-create the function with its previous body:
--     create or replace function public.phx_marketing_roi_latest_validated_period()
--     returns text language sql stable set search_path to 'public' set statement_timeout to '45s'
--     as $$ select max(period) from public.source_of_sales_import_batches where status = 'validated'; $$;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This one is neither: it replaces one read-only function and touches no row.

begin;

set local lock_timeout = '5s';

-- 🔴 "NOT EVERY DISTRIBUTOR UPLOADS EVERY MONTH" IS AN OWNER RULE, SO THE BAR IS THE EVERY-MONTH
--    SET, NEVER A HEADCOUNT. Counting distributors would make a month with a stopped feed look
--    permanently incomplete, and "N of 17 missing" is explicitly never a finding here. The set is
--    measured over the SETTLED months only — every month except the newest — because the newest is
--    the one being judged and including it would let a single early file define the bar it then
--    passes.
create or replace function public.phx_marketing_roi_latest_validated_period()
returns text
language sql
stable
set search_path to 'public'
set statement_timeout to '45s'
as $function$
  with loaded as (
    select distinct b.period, b.distributor_code
    from public.source_of_sales_import_batches b
    where b.status = 'validated' and coalesce(btrim(b.period), '') <> ''
  ),
  months as (select distinct period from loaded),
  settled as (
    select period from months
    where period < (select max(period) from months)
  ),
  every_month as (
    select l.distributor_code
    from loaded l
    where l.period in (select period from settled)
    group by l.distributor_code
    having count(distinct l.period) = (select count(*) from settled)
  ),
  complete as (
    select max(m.period) as period
    from months m
    -- A month counts as loaded when nobody in the every-month set is still missing from it.
    where not exists (
      select 1 from every_month e
      where not exists (
        select 1 from loaded l where l.period = m.period and l.distributor_code = e.distributor_code
      )
    )
  )
  -- 🔴 WITH ONE MONTH OF HISTORY THERE IS NO EVERY-MONTH SET, and the NOT EXISTS above then passes
  --    vacuously for every month — so the answer is taken from `complete` only once a set exists.
  --    Otherwise fall back to the old reading: a system holding its first month should report that
  --    month, and reporting nothing would make every campaign read "waiting" for ever.
  select case
    when (select count(*) from settled) = 0 then (select max(period) from months)
    else (select period from complete)
  end;
$function$;

notify pgrst, 'reload schema';

commit;
