-- Register the EPDA-Pharmacies distributor (code EP-PHS) — SATO's own pharmacies/retail ERP export
-- (ساتو قطاع الصيدليات). Same layout as EPDA-BULK (EP-BK) but a separate code so wholesale vs
-- pharmacy sales stay split. Makes it appear in the Sales Upload dropdown and satisfies the
-- source_of_sales_import_batches.distributor_code FK so its monthly uploads can persist. Its
-- recognition profile lives in code: RAW_DISTRIBUTOR_PROFILES "EP-PHS" in
-- src/lib/sales/normalizer/profiles.ts. Idempotent + additive reference row only.

INSERT INTO public.source_of_sales_distributors
  (distributor_code, distributor_name, normalized_distributor_name, active)
VALUES ('EP-PHS', 'EPDA-Pharmacies', 'epda-pharmacies', true)
ON CONFLICT (distributor_code) DO UPDATE
  SET distributor_name = excluded.distributor_name,
      normalized_distributor_name = excluded.normalized_distributor_name,
      active = true,
      updated_at = now();
