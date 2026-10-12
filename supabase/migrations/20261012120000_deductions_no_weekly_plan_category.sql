-- Deductions: the `no_weekly_plan` category.
--
-- Owner, 2026-10-12: "add a no weekly plans deduction of one day in the daily connectors if not
-- submitted a weekly plan till monday of this week a 1 day deduction but never fired automatic
-- always under the approval of system admin", narrowed to "this rule for head office employees
-- only for now".
--
-- TWO gates stand between a line and this table, and BOTH have to be opened or a publish fails
-- at runtime with nothing in CI to catch it:
--   1. deductions_categories_category_check — a CHECK with the allowed category names spelled out.
--   2. the row itself, because daily_deductions_lines.category and deductions_candidates.category
--      are both FOREIGN KEYs onto deductions_categories(category).
-- The list below is the live constraint read on production 2026-10-12 plus the one new value;
-- nothing existing is dropped (`crm_half_day` stays, retired-but-historical as it is).
--
-- requires_approval = true is the half of "never fired automatic" that lives in the database. The
-- other half is structural: the connector is registered in the DAILY module only and never in
-- DEDUCTION_COLLECTORS, so no month scan can write it (pinned by
-- tests/daily-deductions-no-weekly-plan.test.ts).
--
-- Paid through other_deductions, like no_records_activity — salary_records has no weekly-plan
-- column, its own CHECK allows only five, and inventing one would change the payroll sheet's shape.

alter table public.deductions_categories
  drop constraint if exists deductions_categories_category_check;

alter table public.deductions_categories
  add constraint deductions_categories_category_check check (
    category = any (array[
      'fingerprint',
      'crm',
      'crm_half_day',
      'no_records_activity',
      'unpaid_vacation',
      'insufficient_balance_vacation',
      'no_weekly_plan',
      'loan',
      'other'
    ]::text[])
  );

insert into public.deductions_categories (category, label, detection_engine, requires_approval, salary_records_column, sort_order)
values ('no_weekly_plan', 'No Weekly Plan', 'weekly_plan_submission', true, 'other_deductions', 9)
on conflict (category) do update
  set label = excluded.label,
      detection_engine = excluded.detection_engine,
      requires_approval = excluded.requires_approval,
      salary_records_column = excluded.salary_records_column,
      sort_order = excluded.sort_order;
