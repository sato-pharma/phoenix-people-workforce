-- Remove EP-R and EP-S distributor codes — both were created by mistake and have never
-- had any sales data uploaded. EP-S holds 763 customer map entries which are reassigned
-- to the parent EP (EPDA) distributor before deletion.
--
-- Steps:
--   1. Reassign EP-S customer_map rows to EP, dropping any that already exist under EP
--      (to honour the UNIQUE distributor_code+customer_code constraint).
--   2. Remove EP-R and EP-S from marketing_roi_distributor_rollup.
--   3. Remove EP-R and EP-S from source_of_sales_distributors.
--
-- Safe: no source_of_sales_import_rows, import_batches, or source_of_sales_reference_aliases
-- rows reference these codes. Production has 4 monthly_sales_run_step rows (batch_id = null,
-- no actual import data) which are deleted first to clear the FK. Idempotent.

-- 0. Remove orphaned monthly_sales_run_step rows (batch_id = null means no upload occurred)
DELETE FROM public.monthly_sales_run_step
WHERE distributor_code IN ('EP-R', 'EP-S');

-- 1a. Delete EP-S customer_map rows whose customer_code already exists under EP
--     (avoid UNIQUE violation on the update that follows)
DELETE FROM public.source_of_sales_customer_map eps
WHERE eps.distributor_code = 'EP-S'
  AND EXISTS (
    SELECT 1 FROM public.source_of_sales_customer_map ep
    WHERE ep.distributor_code = 'EP'
      AND ep.customer_code = eps.customer_code
  );

-- 1b. Reassign remaining EP-S customer_map rows to EP
UPDATE public.source_of_sales_customer_map
SET distributor_code = 'EP',
    updated_at       = now()
WHERE distributor_code = 'EP-S';

-- 2. Remove from ROI distributor rollup
DELETE FROM public.marketing_roi_distributor_rollup
WHERE sos_distributor_code IN ('EP-R', 'EP-S');

-- 3. Remove from distributor registry
DELETE FROM public.source_of_sales_distributors
WHERE distributor_code IN ('EP-R', 'EP-S');
