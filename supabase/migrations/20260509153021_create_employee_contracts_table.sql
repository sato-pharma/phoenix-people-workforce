
CREATE TABLE IF NOT EXISTS employee_contracts (
  id                    BIGSERIAL PRIMARY KEY,
  hr_id                 TEXT NOT NULL REFERENCES employees(hr_id),
  contract_type         TEXT NOT NULL DEFAULT 'fixed-term',
  contract_renewal_date DATE NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','expired','renewed','terminated')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_contracts_hr_id ON employee_contracts (hr_id);
CREATE INDEX IF NOT EXISTS idx_employee_contracts_renewal
  ON employee_contracts (contract_renewal_date) WHERE status = 'active';
;
