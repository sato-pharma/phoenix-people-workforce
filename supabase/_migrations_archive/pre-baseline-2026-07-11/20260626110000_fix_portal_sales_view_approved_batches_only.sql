-- Fix v_employee_portal_sales to only expose records from approved, non-replaced
-- batches with non-failed validation — matching exactly how /sales/queue counts
-- achievement (approved batch status, replaced_by_batch_id IS NULL, validation_state != 'failed').
-- Previously the view included ALL records regardless of batch status, causing the
-- incentive portal to compute achievement over pending/rejected/superseded data.

create or replace view public.v_employee_portal_sales as
select
  r.id,
  r.batch_id,
  coalesce(r.employee_hr_id, r.manager_hr_id) as hr_id,
  r.employee_hr_id,
  r.employee_name,
  r.manager_hr_id,
  r.employee_crm_id,
  r.employee_lookup_key,
  r.line,
  r.territory,
  r.sales_type,
  r.family,
  r.product,
  r.month,
  r.year,
  r.factory_price,
  r.sales_units,
  r.sales_value,
  r.target_units,
  r.target_value,
  case
    when r.target_value > 0
    then round((r.sales_value / r.target_value * 100)::numeric, 2)
    else null
  end as achievement_value_percent,
  case
    when r.target_units > 0
    then round((r.sales_units / r.target_units * 100)::numeric, 2)
    else null
  end as achievement_units_percent,
  r.validation_state,
  r.link_status,
  r.link_confidence,
  r.created_at
from public.sales_records r
join public.sales_import_batches b on r.batch_id = b.id
where (r.employee_hr_id is not null or r.manager_hr_id is not null)
  and b.status = 'approved'
  and b.replaced_by_batch_id is null
  and r.validation_state <> 'failed';

-- Re-apply security_invoker so RLS on underlying tables is respected.
alter view public.v_employee_portal_sales set (security_invoker = true);
