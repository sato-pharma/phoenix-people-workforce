-- Repair fraud_flags_json to jsonb if it was previously created as text.
-- Needed because 20260615085001 originally defined it as text, which breaks the
-- v_unified_audit_logs UNION where all metadata branches must be jsonb.
-- The DO block is idempotent: only fires when the column is text, skipped on
-- production (where it was always jsonb) and fresh envs (085001 now creates it jsonb).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name  = 'outstation_location_audit_logs'
      AND column_name = 'fraud_flags_json'
      AND udt_name    = 'text'
  ) THEN
    ALTER TABLE public.outstation_location_audit_logs
      ALTER COLUMN fraud_flags_json TYPE jsonb USING fraud_flags_json::jsonb;
  END IF;
END $$;
