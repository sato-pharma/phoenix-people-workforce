CREATE TABLE IF NOT EXISTS employee_probation (
  id                  BIGSERIAL PRIMARY KEY,
  hr_id               TEXT NOT NULL REFERENCES employees(hr_id),
  probation_end_date  DATE NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','passed','extended','terminated')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_probation_hr_id ON employee_probation (hr_id);
CREATE INDEX IF NOT EXISTS idx_employee_probation_end
  ON employee_probation (probation_end_date) WHERE status = 'active';
