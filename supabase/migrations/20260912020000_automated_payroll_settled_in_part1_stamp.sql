-- ---------------------------------------------------------------------------
-- The Part 1 / Part 2 deduction split is stamped onto the row at Part 1 confirm.
--
-- Whether an employee's loan, CRM or unpaid-vacation deduction belongs in Part 1
-- or Part 2 is decided by `isSettledInPart1`, which reads the employee's payment
-- mode and lifecycle LIVE, every time any step is opened. The columns it routes
-- money into are permanent.
--
-- So correcting somebody from one-part to two-part between the two confirms left
-- their loan sitting in the Part 1 column from before, offered it again on the
-- Part 2 step, and deducted it twice. The mirror correction means it reaches no
-- step at all and is never taken. Nothing detects either: the double-deduction
-- warning is switched off on every Part 1 deduction step.
--
-- `settled_in_part1` freezes that decision beside `first_part_frozen`, in the
-- same write, at the same moment. NULL means Part 1 is not confirmed yet, and
-- the live rule is still the right answer — which is also what every run that
-- predates this column reads, so nothing already on the books moves.
-- ---------------------------------------------------------------------------

alter table public.automated_payroll_draft_rows
  add column if not exists settled_in_part1 boolean;

comment on column public.automated_payroll_draft_rows.settled_in_part1 is
  'The Part 1 / Part 2 deduction routing, frozen at Part 1 confirm alongside '
  'first_part_frozen. NULL = not frozen yet, so the live rule answers. Cleared '
  'when a run is reopened to Part 1.';
