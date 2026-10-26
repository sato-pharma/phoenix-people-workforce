-- Held Salary Release — the Part 2 step that pays salary an earlier published month withheld.
--
-- Owner, 2026-10-26: a salary held in one month (a resigned rep's Part 2, for example) was never paid
-- afterwards. The held balance lived only on the held-salary sheet; no later run picked it up. The new
-- step recommends the outstanding balance per person, HR confirms or lowers it, and publish records the
-- payment in automated_payroll_held_settlements so it is released once.
--
-- Additive and nullable: a row read before this column existed means "no release".
-- Rollback: alter table public.automated_payroll_draft_rows drop column if exists held_release_value;

alter table public.automated_payroll_draft_rows add column if not exists held_release_value numeric;
comment on column public.automated_payroll_draft_rows.held_release_value is
  'Held Salary Release step -> amount of an earlier month''s withheld salary paid in this month''s Part 2 (Other Additions). Never above the outstanding held balance; publish settles it against automated_payroll_held_settlements.';
