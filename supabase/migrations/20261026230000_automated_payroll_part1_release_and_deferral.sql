-- Held Salary Release and Defer Pay in PART 1 too (owner, 2026-10-26: "it should be also in part one.
-- For example, if an employee is resigned and his value of working days is only covered in the first
-- part"). He chose both steps in Part 1 as well as Part 2: what Part 1 releases or defers moves Part 1's
-- bank file, and Part 2 only handles what is left.
--
-- 1. draft_rows.held_release_p1_value — the Part 1 Held Salary Release: an earlier month's held salary
--    paid in THIS month's first instalment. Reserved against the held month at Part 1 confirm.
--
-- 2. draft_rows.pay_deferral_p1_value / pay_deferral_p1_month — the Part 1 Defer Pay: an amount taken
--    off this month's first instalment and owed again next month or the month after. Its own month,
--    because HR may defer Part 1 and Part 2 to different months.
--
-- The Part 2 columns (20261026180000, 20261026210000) are unchanged. Additive.
-- Rollback: alter table public.automated_payroll_draft_rows drop column if exists held_release_p1_value,
--   drop column if exists pay_deferral_p1_value, drop column if exists pay_deferral_p1_month;

alter table public.automated_payroll_draft_rows
  add column if not exists held_release_p1_value numeric(14, 2),
  add column if not exists pay_deferral_p1_value numeric(14, 2),
  add column if not exists pay_deferral_p1_month text;

alter table public.automated_payroll_draft_rows
  drop constraint if exists automated_payroll_draft_rows_part1_release_deferral_check;
alter table public.automated_payroll_draft_rows
  add constraint automated_payroll_draft_rows_part1_release_deferral_check check (
    (held_release_p1_value is null or held_release_p1_value >= 0)
    and (pay_deferral_p1_value is null or pay_deferral_p1_value >= 0)
    and (pay_deferral_p1_month is null or pay_deferral_p1_month in ('next', 'after_next'))
  );

comment on column public.automated_payroll_draft_rows.held_release_p1_value is
  'Part 1 Held Salary Release -> earlier held salary paid in this month''s Part 1. Nothing on a row held at Part 1 confirm.';
comment on column public.automated_payroll_draft_rows.pay_deferral_p1_value is
  'Part 1 Defer Pay -> amount taken off this month''s Part 1 and owed again later. Never above the row''s Part 1; nothing on a row held at Part 1 confirm.';
comment on column public.automated_payroll_draft_rows.pay_deferral_p1_month is
  'Part 1 Defer Pay -> when the deferred amount falls due: next or after_next.';
