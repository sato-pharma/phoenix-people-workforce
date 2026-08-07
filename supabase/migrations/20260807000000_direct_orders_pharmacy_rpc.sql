CREATE OR REPLACE FUNCTION public.phx_resolve_directory_pharmacy(
  p_distributor_code text,
  p_customer_code text,
  p_pharmacy_name text,
  p_brick_id text,
  p_area_code text,
  p_region_code text,
  p_address text,
  p_hr_id text
) RETURNS uuid AS $$
DECLARE
  v_pharmacy_id uuid;
BEGIN
  -- 1. Try to find existing link
  SELECT pharmacy_id INTO v_pharmacy_id 
  FROM public.direct_order_pharmacy_distributor_codes 
  WHERE distributor_code = p_distributor_code AND customer_code = p_customer_code;
  
  IF v_pharmacy_id IS NOT NULL THEN
    RETURN v_pharmacy_id;
  END IF;

  -- 2. Insert shell and link using UPSERT to avoid exceptions
  WITH new_pharmacy AS (
    INSERT INTO public.direct_order_pharmacies (pharmacy_name, brick_id, area_code, region_code, pharmacy_address, created_by_hr_id, verification_status, entry_source, verified_by_hr_id, verified_at)
    VALUES (p_pharmacy_name, p_brick_id, p_area_code, p_region_code, p_address, p_hr_id, 'verified', 'catalogue', p_hr_id, now())
    RETURNING id
  ),
  new_link AS (
    INSERT INTO public.direct_order_pharmacy_distributor_codes (pharmacy_id, distributor_code, customer_code, mapped_brick_id, mapped_area_code, mapped_region_code)
    SELECT id, p_distributor_code, p_customer_code, p_brick_id, p_area_code, p_region_code FROM new_pharmacy
    ON CONFLICT (distributor_code, customer_code) DO NOTHING
    RETURNING pharmacy_id
  )
  SELECT pharmacy_id INTO v_pharmacy_id FROM new_link;

  -- 3. If ON CONFLICT DO NOTHING triggered, it means someone else won the race.
  IF v_pharmacy_id IS NULL THEN
    -- Another connection inserted the link just before we did. The new_pharmacy shell we just inserted is an orphan.
    -- (We can clean it up asynchronously or right here, but the unique constraint error is avoided).
    SELECT pharmacy_id INTO v_pharmacy_id 
    FROM public.direct_order_pharmacy_distributor_codes 
    WHERE distributor_code = p_distributor_code AND customer_code = p_customer_code;
  END IF;

  RETURN v_pharmacy_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
REVOKE EXECUTE ON FUNCTION public.phx_resolve_directory_pharmacy(text, text, text, text, text, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phx_resolve_directory_pharmacy(text, text, text, text, text, text, text, text) TO service_role;