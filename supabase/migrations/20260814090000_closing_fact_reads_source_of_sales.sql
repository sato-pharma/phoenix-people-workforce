-- ─────────────────────────────────────────────────────────────────────────────
-- analytics.closing_fact reads SoS Monthly Closing, not the closing-sheet import table.
--
-- WHY
-- This view is the "closing" leg of the reconciliation dashboard (both mounts:
-- /admin/analytics/reconciliation and /employee-portals/sales-analytics/reconciliation),
-- reached through closing_by_line -> cross_source_period_line -> analytics_cross_source. It
-- also feeds closing_by_employee and closing_by_product.
--
-- Until now it read `sales_records` — the manually uploaded closing sheet. Two problems,
-- both measured on production 2026-08-14:
--
--   1. IT DISAGREES WITH EVERY OTHER SCREEN. Rule #1 in this system is that the same person's
--      same month reads identically everywhere, and SoS Monthly Closing is the truth. The
--      legacy sheet ran between -42.6% and +38.8% against SoS at line level across 2026-01
--      to 2026-06. A manager reading reconciliation saw a "closing" number that appeared
--      nowhere else in the product.
--
--   2. IT HAS ALREADY STOPPED. closing_value is NULL for all of 2026-07 and 2026-08, and for
--      2026-06 Anti Infective — no closing sheet was uploaded. The leg the dashboard exists to
--      show has been empty for the two most recent months.
--
-- WHAT THIS DOES TO THE "Close vs SoS %" COLUMN — READ THIS BEFORE RESTORING IT
-- It removes it, because after this change it can only ever read 0.00%.
--
-- Attribution redistributes a line's value DOWN it (line -> region -> area -> seat, Office
-- golden rule included). It never moves value BETWEEN lines and never drops any. So once the
-- closing leg is the attributed SoS, closing == SoS at (period, line) grain by construction.
-- Measured on production over 2026-01..2026-08, every line in every period: gap 0.00%.
--
-- An earlier draft of this migration claimed that gap would become a real attribution-loss
-- signal. That was wrong, and the measurement is what corrected it. Attribution loss is real,
-- but it is only visible at AREA or REP grain — this view is aggregated to line, so the loss
-- has already been summed back in by the time it gets here.
--
-- The other pair is no substitute: `weekly_value` runs 2x to 15x `sos_value` on the same line
-- and month (2026-07 Anti Infective: 9,562,243 weekly vs 612,194 SoS). Weekly sell-out is a
-- different universe — cumulative, branch-grain, stock-inclusive — so a weekly-vs-closing
-- percentage would read +1,462% and mean nothing.
--
-- So no honest gap percentage exists at this grain, and a column labelled "Close vs SoS %"
-- reading a flat 0.00% is worse than no column: it tells a manager a reconciliation check
-- passed when nothing was checked. The three legs stay, side by side, with the dashboard's
-- notes explaining what each one measures. Re-cut at area grain, the comparison becomes real
-- again — that is the change worth making, not restoring this column.
--
-- WHAT IS DELIBERATELY DIFFERENT IN THE FACT VIEW
--   * BATCHES ARE GONE. The canonical engine has no upload batch, so batch_id is NULL and
--     batch_status is 'approved' (there is no draft state to represent). Downstream views
--     still group by batch_id; a single NULL group is correct, not a bug.
--   * SALES TYPE IS BLANK. There is no Retail/Stores split in the closing. A fabricated token
--     would put a channel split on screen that the data does not record.
--   * TARGETS ARE GATED ON THE DISTRIBUTOR UPLOAD LEDGER. au.monthly_targets holds 17,508,935
--     for 2026-08 while SoS holds ONE direct order (1,309.50 EGP, booked 2026-08-10). Carrying
--     that target through would put a 0.01% achievement on the dashboard for a month nobody
--     has uploaded. Sales are reported for every month the engine has; a target — and hence
--     achievement_pct — appears only once the month's distributor files have landed. Direct
--     and DirectReq batches are excluded from that test for exactly the reason above: they
--     arrive one order at a time, all month long, and are not evidence the month is in.
--   * NO JULY FLOOR. au.f_sales_vs_target_range clamps to 2026-07-01 because that is the
--     /sales-vs-target PICKER's policy. Reconciliation reports history, so this view calls
--     au.f_monthly_achievement per period directly and covers every month SoS holds.
--
-- Confidential products (LA003 / LA004 / SS001) stay excluded, now by CODE rather than by a
-- lowercased name match. They are the whole of the Head Office line, which is why that line
-- shows SoS with no closing figure — unchanged from the previous definition.
--
-- No table is created, dropped, or written. Views and one read-only RPC only.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace view analytics.closing_fact as
with sos_periods as (
  -- Every month Source of Sales actually holds rows for, from validated batches only.
  select distinct f.period
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b
    on b.id = f.batch_id
   and b.status = 'validated'
),
uploaded_periods as (
  -- The months whose DISTRIBUTOR upload has landed. `has_actual` cannot tell a landed month
  -- from a stray direct order; this ledger can.
  select distinct b.period
  from public.source_of_sales_import_batches b
  where lower(btrim(coalesce(b.distributor_code, ''))) not in ('direct', 'directreq')
),
achievement as (
  select a.*
  from sos_periods p
  cross join lateral au.f_monthly_achievement(p.period) a
)
select
  left(a.period, 4)::integer                                as year,
  right(a.period, 2)::integer                               as month,
  right(a.period, 2)                                        as month_str,
  a.period                                                  as period,
  null::uuid                                                as batch_id,
  'source-of-sales-monthly-closing'::text                   as batch_file,
  'approved'::text                                          as batch_status,
  l.line_name                                               as line,
  upper(btrim(a.rep_hr_id))                                 as employee_hr_id,
  e.full_name                                               as employee_name,
  upper(btrim(a.dm_hr_id))                                  as manager_hr_id,
  coalesce(nullif(btrim(ar.area_name), ''), a.area_code)    as territory,
  ''::text                                                  as sales_type,
  coalesce(nullif(btrim(pr.product_name), ''), a.product_code) as product,
  coalesce(pr.family, '')                                   as family,
  a.actual_units                                            as sales_units,
  a.actual_value                                            as sales_value,
  case when up.period is not null then a.target_units end   as target_units,
  case when up.period is not null then a.target_value end   as target_value,
  'valid'::text                                             as validation_state,
  case when a.rep_hr_id is not null and btrim(a.rep_hr_id) <> ''
       then 'linked' else 'unlinked' end                    as link_status,
  -- NULL when there is no target to divide by, never 0 — a rep with sales and no target has
  -- no achievement figure, which is a different statement from achieving nothing.
  case
    when up.period is not null and a.target_value > 0
      then round(a.actual_value / a.target_value * 100::numeric, 2)
    else null::numeric
  end                                                       as achievement_pct,
  a.product_code                                            as product_code
from achievement a
join au.lines l
  on l.line_code = a.line_code
left join uploaded_periods up
  on up.period = a.period
left join public.source_of_sales_areas ar
  on upper(btrim(ar.area_code)) = upper(btrim(a.area_code))
left join public.source_of_sales_products pr
  on upper(btrim(pr.product_code)) = upper(btrim(a.product_code))
left join public.employees e
  on upper(btrim(e.hr_id)) = upper(btrim(a.rep_hr_id))
where upper(btrim(coalesce(a.product_code, ''))) not in ('LA003', 'LA004', 'SS001');

comment on view analytics.closing_fact is
  'Monthly closing at (period, line, area, product, rep) grain, sourced from SoS Monthly Closing '
  'via au.f_monthly_achievement. Targets and achievement_pct appear only for months whose '
  'distributor upload has landed. Confidential products excluded.';

-- ── The reconciliation roll-up, minus the column that can no longer say anything ────────────
-- Dropped and recreated rather than replaced: CREATE OR REPLACE VIEW cannot remove a column.
-- Nothing else depends on this view (checked on production 2026-08-14 — closing_by_employee,
-- closing_by_line and closing_by_product hang off closing_fact, not off this).

drop view if exists analytics.cross_source_period_line;

create view analytics.cross_source_period_line as
with sos as (
  select period, line, sum(value) as sos_value, sum(units) as sos_units
  from analytics.sos_by_line
  group by period, line
),
closing as (
  select period, line,
         sum(sales_value)  as closing_value,
         sum(sales_units)  as closing_units,
         sum(target_value) as target_value,
         sum(target_units) as target_units
  from analytics.closing_by_line
  group by period, line
),
weekly as (
  select period, line, sum(sales_value) as weekly_value, sum(sales_qty) as weekly_units
  from analytics.weekly_fact
  group by period, line
)
select
  coalesce(s.period, c.period, w.period) as period,
  coalesce(s.line, c.line, w.line)       as line,
  s.sos_value,
  s.sos_units,
  c.closing_value,
  c.closing_units,
  c.target_value,
  c.target_units,
  w.weekly_value,
  w.weekly_units,
  case
    when c.target_value > 0::numeric
      then round(c.closing_value / c.target_value * 100::numeric, 2)
    else null::numeric
  end as closing_achievement_pct
from sos s
full join closing c using (period, line)
full join weekly w using (period, line);

comment on view analytics.cross_source_period_line is
  'Source of Sales, Monthly Closing and Weekly Sales aligned on (period, line). The three legs '
  'measure different things and are not expected to agree: SoS and Closing are the same '
  'measurement at this grain (Closing is SoS attributed down to seats), and Weekly is '
  'cumulative branch sell-out. No gap percentage is published here because none of them is '
  'meaningful before the view is re-cut at area grain.';

grant select on analytics.cross_source_period_line to analytics_readonly;

-- ── The RPC both mounts call ────────────────────────────────────────────────────────────────
-- Dropped and recreated because its RETURNS TABLE signature loses a column.

drop function if exists public.analytics_cross_source(text, text, text[]);

create function public.analytics_cross_source(
  p_period_from text default null,
  p_period_to   text default null,
  p_lines       text[] default null
)
returns table (
  period text,
  line text,
  sos_value numeric,
  sos_units numeric,
  closing_value numeric,
  closing_units numeric,
  target_value numeric,
  weekly_value numeric,
  weekly_units numeric,
  closing_achievement_pct numeric
)
language sql
stable
security definer
set search_path to 'analytics', 'public'
as $function$
  select period, line,
         sos_value, sos_units,
         closing_value, closing_units, target_value,
         weekly_value, weekly_units,
         closing_achievement_pct
  from   analytics.cross_source_period_line
  where  (p_period_from is null or period >= p_period_from)
    and  (p_period_to   is null or period <= p_period_to)
    and  (p_lines is null       or line = any(p_lines))
  order by period desc, line;
$function$;

-- Match the previous ACL exactly: EXECUTE for service_role, nothing for PUBLIC.
--
-- Spelled `revoke execute … from public, anon, authenticated` rather than `revoke all … from
-- public`. The two are equivalent for a function — ALL *is* EXECUTE — but a new SECURITY DEFINER
-- function in `public` is callable with the anonymous key until PUBLIC is revoked, and
-- scripts/check-migrations.mjs (rule 4, also pinned by tests/migrations-secdef-revoke-guard.test.ts)
-- requires the explicit form so the intent is greppable across 271 migrations rather than inferred.
-- Naming all three roles is belt-and-braces: revoking PUBLIC is what actually removes anon's and
-- authenticated's access, and the re-grant below is required because revoking PUBLIC on a default
-- ACL also strips service_role.
revoke execute on function public.analytics_cross_source(text, text, text[])
  from public, anon, authenticated;
grant execute on function public.analytics_cross_source(text, text, text[]) to service_role;
