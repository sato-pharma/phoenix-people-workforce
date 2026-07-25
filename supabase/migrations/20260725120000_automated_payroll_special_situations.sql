-- Automated Payroll — Special Situations tab (add-only).
--
-- Adds 5 columns to automated_payroll_draft_rows for the new Part 1 "Special
-- Situations" step: a manual deduction and a manual addition, each entered as a
-- day count that auto-calculates its money value (Base/30 x days, same formula
-- as the other Part 1 day-rate fields), plus ONE shared routing choice that
-- applies to BOTH the deduction and the addition (owner-confirmed 2026-07-25:
-- "whatever i choose is actually synced the same for addition field").
--
-- Unlike the 4 existing Part 1 manual-deduction tabs, this step shows every
-- employee regardless of payment mode — it exists precisely for cases that fall
-- outside the normal one-part/two-part rules.
--
-- No existing column is touched; RLS/grants already cover the whole table.

alter table public.automated_payroll_draft_rows
  add column if not exists special_deduction_days numeric(8, 2),
  add column if not exists special_deduction_value numeric(12, 2),
  add column if not exists special_addition_days numeric(8, 2),
  add column if not exists special_addition_value numeric(12, 2),
  add column if not exists special_situation_part text
    check (special_situation_part is null or special_situation_part in ('first', 'second'));
