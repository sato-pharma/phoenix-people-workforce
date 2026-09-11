-- ---------------------------------------------------------------------------
-- The Additions step gets a reason of its own.
--
-- Additions is the ONLY step that adds money to a payslip, and it had no feeder,
-- no source, no reason and no upper limit. A 50,000 EGP bonus typed against one
-- employee was accepted by the grid, by the route and by the pre-flight
-- validator, and reached the payslip with nothing recording who asked for it.
--
-- `manual_reason` already exists but belongs to the Part 2 Manual Deductions
-- step; sharing it would let a deduction's reason read as an addition's, and the
-- next session would have no way to tell which decision a sentence describes.
-- ---------------------------------------------------------------------------

alter table public.automated_payroll_draft_rows
  add column if not exists additions_reason text;

comment on column public.automated_payroll_draft_rows.additions_reason is
  'Why this employee is being paid an incentive, bonus or overtime this month. '
  'Required by confirmAdditions whenever any of the three is non-zero.';
