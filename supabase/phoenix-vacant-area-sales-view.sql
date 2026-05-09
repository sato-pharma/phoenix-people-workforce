-- Fix v_employee_portal_sales to include vacant territory records under the DSM.
-- Previously the view excluded rows where employee_hr_id IS NULL (unlinked/vacant areas).
-- Now we COALESCE(employee_hr_id, manager_hr_id) so that vacant-territory rows
-- appear under the DSM's hr_id and are included in their team totals.

DROP VIEW IF EXISTS public.v_employee_portal_sales;

CREATE VIEW public.v_employee_portal_sales AS
SELECT
  id,
  batch_id,
  COALESCE(employee_hr_id, manager_hr_id) AS hr_id,
  employee_hr_id,
  employee_name,
  manager_hr_id,
  employee_crm_id,
  employee_lookup_key,
  line,
  territory,
  sales_type,
  family,
  product,
  month,
  year,
  factory_price,
  sales_units,
  sales_value,
  target_units,
  target_value,
  CASE
    WHEN target_value > 0
    THEN round((sales_value / target_value * 100)::numeric, 2)
    ELSE NULL
  END AS achievement_value_percent,
  CASE
    WHEN target_units > 0
    THEN round((sales_units / target_units * 100)::numeric, 2)
    ELSE NULL
  END AS achievement_units_percent,
  validation_state,
  link_status,
  link_confidence,
  created_at
FROM sales_records
WHERE employee_hr_id IS NOT NULL
   OR manager_hr_id IS NOT NULL;

-- Fix the stale linked_records counter in sales_import_batches.
-- It was frozen at 6 (the count at import time) and never updated after linkage ran.
UPDATE sales_import_batches sib
SET linked_records = sub.cnt
FROM (
  SELECT batch_id, COUNT(*) AS cnt
  FROM sales_records
  WHERE employee_hr_id IS NOT NULL
  GROUP BY batch_id
) sub
WHERE sib.id = sub.batch_id;

