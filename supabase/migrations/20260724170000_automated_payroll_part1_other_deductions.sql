-- Automated Payroll — Part 1 "Other deductions" step (add-only).
--
-- Adds 15 columns to automated_payroll_draft_rows for the new Part 1 manual
-- deduction step: 5 categories (CRM, Unpaid Vacation, Day Without Record,
-- Loan, Other), each with days/value/reason. No existing column is touched;
-- RLS/grants already cover the whole table.

alter table public.automated_payroll_draft_rows
  add column if not exists p1od_crm_days         numeric(8, 2),
  add column if not exists p1od_crm_value         numeric(14, 2),
  add column if not exists p1od_crm_reason        text,
  add column if not exists p1od_vacation_days     numeric(8, 2),
  add column if not exists p1od_vacation_value    numeric(14, 2),
  add column if not exists p1od_vacation_reason   text,
  add column if not exists p1od_no_record_days    numeric(8, 2),
  add column if not exists p1od_no_record_value   numeric(14, 2),
  add column if not exists p1od_no_record_reason  text,
  add column if not exists p1od_loan_days         numeric(8, 2),
  add column if not exists p1od_loan_value        numeric(14, 2),
  add column if not exists p1od_loan_reason       text,
  add column if not exists p1od_other_days        numeric(8, 2),
  add column if not exists p1od_other_value       numeric(14, 2),
  add column if not exists p1od_other_reason      text;
