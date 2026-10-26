-- roi_frontier_ignores_direct_orders_and_the_future
--
-- WHAT THIS CHANGES: `phx_marketing_roi_latest_validated_period()` — the ROI tracker's "sales loaded
--   through" flag — (1) no longer counts the direct-orders feed (template_key 'direct_orders',
--   distributor_code 'DirectReq') as a month of distributor files, and (2) never answers a month
--   later than the last FINISHED month in Africa/Cairo.
-- WHY: on 2026-10-26 the page read "Validated sales through Nov 2026". The direct-orders feed writes
--   one validated batch per month, dated by the order — a November order created 14 Oct produced a
--   2026-11 batch, and October holds only its 2026-10 batch. Both months therefore held ONE batch and
--   no distributor file. With 2026-10 counted as "settled", no distributor was present in every settled
--   month, the every-month set came out EMPTY, the NOT EXISTS test passed vacuously for every month and
--   max() returned 2026-11. One request (EGP 1,000, Aug -> Oct window) read JUDGED / BEHIND at 100%
--   confidence and the Nov group said "DATA HAS ARRIVED". The distributor files for October do not
--   exist yet. Measured on production before this change: frontier 2026-11; after: 2026-08 (the every-month distributors have not filed September).
--   The ROI report attributes raw loaded sales rows (the documented carve-out from the Monthly Closing
--   rule), so the frontier stays a file-completeness flag, not the published closing.
-- ROLLBACK: re-apply supabase/migrations/20261002133311_roi_sales_data_asof_every_month_set.sql.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This replaces one read-only function and touches no row, so it is neither destructive nor bulk.

begin;

set local lock_timeout = '5s';

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
    where b.status = 'validated'
      and coalesce(btrim(b.period), '') <> ''
      -- 🔴 The direct-orders feed is one batch per month, dated by the order, so it exists for a month
      --    whose distributor files have not arrived and for months that have not happened. It is not a
      --    distributor file and never decides a month is loaded.
      and coalesce(b.template_key, '') <> 'direct_orders'
      and upper(coalesce(b.distributor_code, '')) <> 'DIRECTREQ'
      -- 🔴 Nothing is loaded for a month that has not finished (Cairo): the last finished month is the
      --    ceiling, whatever a batch's period says.
      and b.period <= to_char(date_trunc('month', now() at time zone 'Africa/Cairo') - interval '1 month', 'YYYY-MM')
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
    where not exists (
      select 1 from every_month e
      where not exists (
        select 1 from loaded l where l.period = m.period and l.distributor_code = e.distributor_code
      )
    )
  )
  select case
    when (select count(*) from settled) = 0 then (select max(period) from months)
    else (select period from complete)
  end;
$function$;

notify pgrst, 'reload schema';

commit;
