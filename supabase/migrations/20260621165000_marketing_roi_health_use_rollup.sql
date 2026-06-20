-- Make the ROI health check rollup-aware: the double-count probe and the "unbridged
-- distributor codes" warning must use the ROI distributor rollup, so family codes that now
-- attribute (IS-S, EP-S, ...) are no longer falsely flagged. Only genuinely-unmapped codes
-- carrying validated volume (e.g. Office, Direct) are reported.

create or replace function public.phx_marketing_roi_health()
returns jsonb
language sql
stable
set search_path to 'public'
set statement_timeout to '120s'
as $function$
with roi_all as (
  select * from phx_marketing_request_roi_actuals(
    array(select id from marketing_requests where request_code ~ '^REQ-[0-9]{4}$')
  )
),
elig as (
  select mr.id rid, mr.status,
         date_trunc('month', mr.pay_date)::date ws,
         (date_trunc('month', mr.pay_date) + make_interval(months => greatest(mr.roi_duration_months, 1) - 1))::date we
  from marketing_requests mr
  where mr.request_code ~ '^REQ-[0-9]{4}$'
    and mr.status in ('approved','active','roi_tracking','closed','finance_hold')
    and mr.pay_date is not null
),
hit as (
  select distinct e.rid, r.id row_id
  from elig e
  join marketing_request_products mrp on mrp.request_id = e.rid
  join marketing_products mp on mp.id = mrp.product_id
  join marketing_request_pharmacies mrph on mrph.request_id = e.rid
  join marketing_pharmacy_distributor_codes pdc on pdc.pharmacy_id = mrph.pharmacy_id
  join marketing_distributors md on md.id = pdc.distributor_id
  join marketing_roi_distributor_rollup ru on ru.marketing_normalized_name = md.normalized_name
  join source_of_sales_import_rows r on r.distributor_code = ru.sos_distributor_code
  join source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
  join source_of_sales_products sp on sp.product_code = r.product_code and sp.normalized_product_name = mp.normalized_name
  where r.validation_state = 'valid'
    and pdc.normalized_pharmacy_code = lower(btrim(regexp_replace(r.client_code, '\s+', ' ', 'g')))
    and to_date(r.invoice_period, 'YYYY-MM') between date_trunc('month', e.ws) and e.we
),
by_status as (
  select mr.status,
         count(*) filter (where coalesce(a.actual_value, 0) <> 0) reqs_with_value,
         round(coalesce(sum(a.actual_value), 0)::numeric, 2) val
  from marketing_requests mr
  left join roi_all a on a.request_id = mr.id
  where mr.request_code ~ '^REQ-[0-9]{4}$'
  group by mr.status
),
periods as (
  select r.invoice_period, count(*) n
  from source_of_sales_import_rows r
  join source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
  where r.validation_state = 'valid'
  group by r.invoice_period
),
orphans as (
  select d.distributor_code, count(*) n
  from source_of_sales_import_rows r
  join source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
  join source_of_sales_distributors d on d.distributor_code = r.distributor_code
  where r.validation_state = 'valid'
    and not exists (select 1 from marketing_distributors md where md.normalized_name = d.normalized_distributor_name)
    and not exists (select 1 from marketing_roi_distributor_rollup ru where ru.sos_distributor_code = d.distributor_code)
  group by d.distributor_code
),
dc as (
  select count(*) pairs, count(distinct row_id) distinct_rows,
         count(*) - count(distinct row_id) overcount,
         (select count(*) from (select row_id from hit group by row_id having count(distinct rid) > 1) z) shared
  from hit
)
select jsonb_build_object(
  'generated_at', now(),
  'blocked_batches', (select count(*) from source_of_sales_import_batches where status <> 'validated'),
  'validated_periods', (select coalesce(jsonb_agg(jsonb_build_object('period', invoice_period, 'rows', n) order by invoice_period), '[]'::jsonb) from periods),
  'roi_by_status', (select coalesce(jsonb_agg(jsonb_build_object('status', status, 'reqs_with_value', reqs_with_value, 'value', val) order by val desc), '[]'::jsonb) from by_status),
  'dashboard_headline_value', (select coalesce(val, 0) from by_status where status = 'approved'),
  'true_matched_total', (select coalesce(sum(val), 0) from by_status),
  'hidden_pending_value', (select coalesce(val, 0) from by_status where status = 'pending_approval'),
  'double_count', (select jsonb_build_object('pairs', pairs, 'distinct_rows', distinct_rows, 'overcount', overcount, 'rows_shared_by_multiple_requests', shared) from dc),
  'unbridged_distributor_codes_with_volume', (select coalesce(jsonb_agg(jsonb_build_object('code', distributor_code, 'rows', n) order by n desc), '[]'::jsonb) from orphans),
  'unbridged_marketing_products', (select coalesce(jsonb_agg(distinct mp.product_name), '[]'::jsonb)
    from marketing_request_products mrp
    join marketing_products mp on mp.id = mrp.product_id
    join marketing_requests mr on mr.id = mrp.request_id
    where mr.request_code ~ '^REQ-[0-9]{4}$'
      and not exists (select 1 from source_of_sales_products sp where sp.normalized_product_name = mp.normalized_name)),
  'requests_with_only_nonnumeric_codes', (select coalesce(jsonb_agg(rc), '[]'::jsonb) from (
    select mr.request_code rc from marketing_requests mr
    where mr.request_code ~ '^REQ-[0-9]{4}$'
      and exists (select 1 from marketing_request_pharmacies x where x.request_id = mr.id)
      and not exists (
        select 1 from marketing_request_pharmacies mrph
        join marketing_pharmacy_distributor_codes pdc on pdc.pharmacy_id = mrph.pharmacy_id
        where mrph.request_id = mr.id and pdc.normalized_pharmacy_code ~ '^[0-9]+$')) q),
  'overall_pass', (
    (select count(*) from source_of_sales_import_batches where status <> 'validated') = 0
    and (select overcount from dc) = 0
    and (select shared from dc) = 0)
)
$function$;