-- phx_closing_customers attributed every customer by source_of_sales_customer_map, preferring it
-- over the fact rows. That made the Channel Comparison / Channel Breakdown tabs of the monthly
-- closing workbook disagree with the Closing Matrix, which reads the facts.
--
-- It surfaced on the owner's July 2026 Anti-Infective ruling: client 441164 (ريونيون) returned its
-- whole June purchase in July, and he ruled that return is split evenly between Dakahlia 2 and
-- Port Said - Domiat. The split was applied to the sales rows, so the Closing Matrix showed it
-- correctly -- but the customer-driven tabs still parked the entire -34,380.00 under Dakahlia 1,
-- because customer_map says D21 and the map won.
--
-- customer_map has NO period column, so it can never express a one-month exception. Re-pointing it
-- would have dragged June's +34,380.00 along with it. The map is a default, not a fact; the sales
-- row is the fact. This makes the code agree with that.
--
-- Two changes:
--   1. The fact row's own region/area/brick WINS. customer_map is now only the fallback for a fact
--      row that carries none -- legacy Direct rows store '' rather than NULL, hence the nullif.
--      Measured on live data: 2,859 (period, line, client, distributor) groups had a customer_map
--      area that disagreed with their own sales rows. Every one of them now follows the sales.
--   2. agg groups by region/area/brick too, so a customer split across areas yields one row per
--      area instead of collapsing to max(area_code) -- which would have hidden the split even
--      after change 1. Measured on live data: 3 of 153,046 pairs span more than one area or brick,
--      so this adds at most 3 rows in total while making those 3 correct.
--
-- Headline closing values do not move: phx_monthly_closing_matrix already read the facts. This only
-- stops the customer-level tabs contradicting it. Verified after applying, July 2026 Anti-Infective:
-- D21/D22/D23/D26 customer-tab totals equal the matrix exactly (gap 0.00), and 441164 now reports
-- two rows of -200 units / -17,190.00 rather than one of -400 / -34,380.00.
create or replace function public.phx_closing_customers(p_line text, p_period text)
returns table(client_code text, client_name text, distributor_code text, region_code text,
              area_code text, brick_id text, units numeric, value numeric)
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '45s'
as $function$
  with agg as (
    select
      f.client_code,
      f.distributor_code,
      nullif(f.region_code, '') as fact_region,
      nullif(f.area_code, '')   as fact_area,
      nullif(f.brick_id, '')    as fact_brick,
      sum(f.total_qty) as units,
      sum(
        case
          when coalesce(f.is_direct, false) then coalesce(f.direct_value, 0)
          else f.effective_units * coalesce(p.factory_price, 0)
        end
      ) as value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    where f.period = p_period
      and lower(btrim(f.official_line)) = lower(btrim(p_line))
      and f.client_code is not null
      and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
    group by
      f.client_code, f.distributor_code,
      nullif(f.region_code, ''), nullif(f.area_code, ''), nullif(f.brick_id, '')
  )
  select
    a.client_code,
    coalesce(cm.customer_name, '') as client_name,
    a.distributor_code,
    coalesce(a.fact_region, cm.region_code) as region_code,
    coalesce(a.fact_area,   cm.area_code)   as area_code,
    coalesce(a.fact_brick,  cm.brick_id)    as brick_id,
    a.units,
    a.value
  from agg a
  left join public.source_of_sales_customer_map cm
    on cm.distributor_code = a.distributor_code
   and cm.customer_code    = a.client_code
   and cm.active;
$function$;
