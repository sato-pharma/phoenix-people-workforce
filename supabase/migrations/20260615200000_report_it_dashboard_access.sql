-- Per-user access list for the Report It dashboard.
-- Users listed here can view ALL submitted reports, regardless of role.
-- The gate is enforced in src/lib/report-it/service.ts (canViewAllReports).

CREATE TABLE IF NOT EXISTS report_it_dashboard_access (
  hr_id       TEXT        PRIMARY KEY,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by  TEXT        NULL
);

-- Service role reads this via getSupabaseAdmin(); deny all browser-level access.
ALTER TABLE report_it_dashboard_access ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny_all" ON report_it_dashboard_access USING (false);

-- Grant A-3 (Samaa Mosaad Khalil) dashboard access.
INSERT INTO report_it_dashboard_access (hr_id, granted_by)
VALUES ('A-3', 'system-setup')
ON CONFLICT (hr_id) DO NOTHING;
