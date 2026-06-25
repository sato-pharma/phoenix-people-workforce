-- Fix v_employee_portal_sales to include vacant territory records under the DSM,
-- and to only expose records from approved, non-replaced batches with non-failed
-- validation — matching how /sales/queue computes achievement.

DROP VIEW IF EXISTS public.v_employee_portal_sales;

CREATE VIEW public.v_employee_portal_sales AS
SELECT
  r.id,
  r.batch_id,
  COALESCE(r.employee_hr_id, r.manager_hr_id) AS hr_id,
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
  CASE
    WHEN r.target_value > 0
    THEN round((r.sales_value / r.target_value * 100)::numeric, 2)
    ELSE NULL
  END AS achievement_value_percent,
  CASE
    WHEN r.target_units > 0
    THEN round((r.sales_units / r.target_units * 100)::numeric, 2)
    ELSE NULL
  END AS achievement_units_percent,
  r.validation_state,
  r.link_status,
  r.link_confidence,
  r.created_at
FROM sales_records r
JOIN sales_import_batches b ON r.batch_id = b.id
WHERE (r.employee_hr_id IS NOT NULL OR r.manager_hr_id IS NOT NULL)
  AND b.status = 'approved'
  AND b.replaced_by_batch_id IS NULL
  AND r.validation_state <> 'failed';

-- Fix the stale linked_records counter in sales_import_batches.
UPDATE sales_import_batches sib
SET linked_records = sub.cnt
FROM (
  SELECT batch_id, COUNT(*) AS cnt
  FROM sales_records
  WHERE employee_hr_id IS NOT NULL
  GROUP BY batch_id
) sub
WHERE sib.id = sub.batch_id;
