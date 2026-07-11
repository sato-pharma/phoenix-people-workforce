-- Rename the display name of the Office allocation channel from "Office" to "Marcyrl".
-- distributor_code stays 'Office' — it is the key SQL functions (phx_office_region_share,
-- phx_office_brick_share) and application code (OFFICE_DISTRIBUTOR_CODE) match on. Only the
-- label users see changes.

update public.source_of_sales_distributors
set distributor_name = 'Marcyrl',
    normalized_distributor_name = 'marcyrl',
    updated_at = now()
where distributor_code = 'Office';
