-- Migration: Add missing employee data fields (Phase 1 - Employee Master Data)
-- Date: 2026-05-11
-- Purpose: Add critical missing fields for payroll, expenses, and HR compliance

BEGIN;

-- Add missing employee fields to employees table
ALTER TABLE employees
ADD COLUMN IF NOT EXISTS birth_date DATE,
ADD COLUMN IF NOT EXISTS national_id_number VARCHAR(80),
ADD COLUMN IF NOT EXISTS address_from_id_card TEXT,
ADD COLUMN IF NOT EXISTS personal_email VARCHAR(255),
ADD COLUMN IF NOT EXISTS emergency_contact_name VARCHAR(220),
ADD COLUMN IF NOT EXISTS emergency_contact_phone VARCHAR(40),
ADD COLUMN IF NOT EXISTS employee_type VARCHAR(80),
ADD COLUMN IF NOT EXISTS employee_id_number VARCHAR(80);

-- Add bank account fields to employee_compensation table for salary transfer
ALTER TABLE employee_compensation
ADD COLUMN IF NOT EXISTS bank_account_number VARCHAR(40),
ADD COLUMN IF NOT EXISTS bank_name VARCHAR(160),
ADD COLUMN IF NOT EXISTS account_holder_name VARCHAR(220);

-- Create indexes for common searches
CREATE INDEX IF NOT EXISTS idx_employees_national_id
ON employees(national_id_number)
WHERE national_id_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_employees_personal_email
ON employees(LOWER(personal_email))
WHERE personal_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_employees_birth_date
ON employees(birth_date)
WHERE birth_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_employee_compensation_bank_account
ON employee_compensation(bank_account_number)
WHERE bank_account_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_employee_compensation_tax_id
ON employee_compensation(tax_id_number)
WHERE tax_id_number IS NOT NULL;

-- Add constraints for data quality
ALTER TABLE employee_compensation
ADD CONSTRAINT check_positive_insurance_premium
CHECK (insurance_premium_amount IS NULL OR insurance_premium_amount >= 0);

ALTER TABLE employee_compensation
ADD CONSTRAINT check_positive_gratuity_base
CHECK (gratuity_calculation_base IS NULL OR gratuity_calculation_base >= 0);

-- Add comment documentation
COMMENT ON COLUMN employees.birth_date IS 'Employee birth date (from ID card or HR record)';
COMMENT ON COLUMN employees.national_id_number IS 'National ID number (passport, emirates ID, Aadhar, etc.)';
COMMENT ON COLUMN employees.address_from_id_card IS 'Address registered on national ID card (for expense tracking)';
COMMENT ON COLUMN employees.personal_email IS 'Personal email address for non-work communications';
COMMENT ON COLUMN employees.emergency_contact_name IS 'Name of emergency contact person';
COMMENT ON COLUMN employees.emergency_contact_phone IS 'Phone number of emergency contact';
COMMENT ON COLUMN employees.employee_type IS 'Employment type: full-time, contract, freelance, part-time';
COMMENT ON COLUMN employees.employee_id_number IS 'Alternate employee ID number from legacy systems';

COMMENT ON COLUMN employee_compensation.bank_account_number IS 'Bank account number for salary transfer (IBAN or account number)';
COMMENT ON COLUMN employee_compensation.bank_name IS 'Name of bank for salary transfer';
COMMENT ON COLUMN employee_compensation.account_holder_name IS 'Name of bank account holder';

-- Update RLS policies to ensure new fields are protected
-- (Existing RLS on employees table already covers new columns)

COMMIT;
