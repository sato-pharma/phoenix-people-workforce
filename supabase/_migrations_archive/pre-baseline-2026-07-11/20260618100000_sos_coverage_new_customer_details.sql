-- Add per-import new-customer DETAILS (code + name + address) to the coverage snapshot, so the
-- Coverage tab's "persistent unmapped" list can show WHO each recurring code is and be bulk-mapped.
-- Non-destructive: old snapshots keep their code-only `new_customer_codes`; this is additive.
ALTER TABLE sos_import_coverage_snapshots
  ADD COLUMN IF NOT EXISTS new_customer_details jsonb;  -- [{ code, name, address }] capped per import
