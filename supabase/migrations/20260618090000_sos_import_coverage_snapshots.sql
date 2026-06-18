-- sos_import_coverage_snapshots
-- One row per committed SoS import. Written by /api/sales/monthly-import/commit after a successful
-- persist. Feeds the Coverage tab: per-distributor resolved %, trend, drift alerts, persistent unmapped.
CREATE TABLE IF NOT EXISTS sos_import_coverage_snapshots (
  id                      uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id                text          NOT NULL,
  distributor_code        text          NOT NULL,
  period                  text,
  committed_at            timestamptz   NOT NULL DEFAULT now(),
  total_rows              integer       NOT NULL DEFAULT 0,
  importable_rows         integer       NOT NULL DEFAULT 0,
  resolved_pct            numeric(5,1)  NOT NULL DEFAULT 0,
  importable_value        numeric(15,2) NOT NULL DEFAULT 0,
  distinct_customers      integer       NOT NULL DEFAULT 0,
  mapped_customers        integer       NOT NULL DEFAULT 0,
  new_customers           integer       NOT NULL DEFAULT 0,
  unmapped_products_count integer       NOT NULL DEFAULT 0,
  brick_drift_count       integer       NOT NULL DEFAULT 0,
  new_customer_codes      jsonb,   -- text[] of first 50 new customer codes (for persistent-unmapped analysis)
  unmapped_products       jsonb    -- text[] of first 50 unmapped product names
);

CREATE INDEX IF NOT EXISTS sos_coverage_dist_date_idx
  ON sos_import_coverage_snapshots (distributor_code, committed_at DESC);

ALTER TABLE sos_import_coverage_snapshots ENABLE ROW LEVEL SECURITY;

-- All access goes through service_role (bypasses RLS). Direct anon/authenticated access is denied.
CREATE POLICY "sos_coverage_no_direct_access"
  ON sos_import_coverage_snapshots FOR ALL
  USING (false)
  WITH CHECK (false);
