ALTER TABLE salary_flags
  ADD COLUMN IF NOT EXISTS resolved_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_by  TEXT;
CREATE INDEX IF NOT EXISTS idx_salary_flags_unresolved
  ON salary_flags (resolved_at) WHERE resolved_at IS NULL;
