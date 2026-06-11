-- The EPDA Bulk distributor's code is EP-R (it matches the "Distrub ID" column in the user's canonical
-- monthly template), not the EP-B first registered in 20260611014759. Rename the row IN PLACE from
-- EP-B to EP-R — this keeps its unique normalized_distributor_name ('epda bulk') so there is no
-- duplicate-name conflict and no orphan row. Safe: no source_of_sales_import_rows reference EP-B yet
-- (nothing was ever uploaded under it). Idempotent + reversible.

update public.source_of_sales_distributors
  set distributor_code = 'EP-R', active = true, updated_at = now()
  where distributor_code = 'EP-B';
