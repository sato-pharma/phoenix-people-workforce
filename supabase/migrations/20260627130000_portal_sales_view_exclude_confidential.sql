-- Exclude confidential products (LA003 / LA004 = "Lacto Basic 1 & 2", SS001 = "Satoslim")
-- from v_employee_portal_sales at the VIEW level, so EVERY employee-portal reader of this view
-- is confidential-safe by construction — not only the readers that remember to call the TS strip
-- helpers. Today the home snapshot (current-month achievement + 4-month trend), the incentive
-- portal dashboard, and the employee sales-rank queries all read this view directly without any
-- restricted-product filter; a single line aggregate would otherwise fold confidential-product
-- sales into a Marketing Manager's / employee's totals.
--
-- The legacy sales_records table keys products by NAME (there is no product_code column), so the
-- exclusion is NAME-based, mirroring normalizeProductNameKey() + RESTRICTED_PRODUCT_NAME_FALLBACKS
-- in src/lib/sales/access-scope.ts (collapse inner whitespace -> single space, trim, lowercase).
-- The app-layer strip helpers stay in place as defense-in-depth. Confidential products may ONLY
-- ever be revealed to CEO / Super Admin, and this view is portal-facing (never the CEO/Super Admin
-- admin surfaces), so a hard exclusion here is correct for every consumer of the view.

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
  and r.validation_state <> 'failed'
  -- Confidential-product floor (LA003/LA004/SS001 by their legacy names). Normalization mirrors
  -- normalizeProductNameKey() in src/lib/sales/access-scope.ts so renames/whitespace cannot un-hide.
  and lower(btrim(regexp_replace(coalesce(r.product, ''), '\s+', ' ', 'g')))
      not in ('lacto basic 1', 'lacto basic 2', 'satoslim');

-- Re-apply security_invoker so RLS on underlying tables is respected.
alter view public.v_employee_portal_sales set (security_invoker = true);

-- Ask PostgREST to reload its schema cache so the updated view is served immediately.
notify pgrst, 'reload schema';
