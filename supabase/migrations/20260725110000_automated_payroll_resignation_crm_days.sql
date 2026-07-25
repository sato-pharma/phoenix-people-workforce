-- Automated Payroll — Resignations step: editable CRM No-Activity Days (add-only).
--
-- Adds one column to automated_payroll_draft_rows: the editable day count behind the
-- Resignations step's `crm` deduction, so HR can override the day count and have the
-- money value auto-calculate (Base/30 x days) the same way the Part 1 manual deduction
-- tabs already work. No existing column is touched; RLS/grants already cover the whole
-- table.
--
-- Deliberately NOT adding an equivalent for `unpaid_vacations`: that figure is a
-- composite of a balance-aware Phoenix-vacation amount plus a separate CRM-leave
-- amount, not a flat day rate — auto-calculating it from a single day count would
-- silently produce a wrong number for a leaver's final settlement.

alter table public.automated_payroll_draft_rows
  add column if not exists resignation_crm_days numeric(8, 2);
