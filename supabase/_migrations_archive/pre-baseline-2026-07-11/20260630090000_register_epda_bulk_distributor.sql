-- Register the EPDA-BULK distributor (code EP-BK) — SATO's own wholesale ERP export
-- (ساتو قطاع الجملة). This makes it appear in the Sales Upload dropdown and satisfies the
-- source_of_sales_import_batches.distributor_code FK so its monthly uploads can persist.
-- Its recognition profile lives in code: RAW_DISTRIBUTOR_PROFILES "EP-BK" in
-- src/lib/sales/normalizer/profiles.ts (raw sheet — products via the alias dictionary,
-- geography via the customer→brick map, value recomputed). Idempotent + additive reference row only.

INSERT INTO public.source_of_sales_distributors
  (distributor_code, distributor_name, normalized_distributor_name, active)
VALUES ('EP-BK', 'EPDA-BULK', 'epda-bulk', true)
ON CONFLICT (distributor_code) DO UPDATE
  SET distributor_name = excluded.distributor_name,
      normalized_distributor_name = excluded.normalized_distributor_name,
      active = true,
      updated_at = now();
