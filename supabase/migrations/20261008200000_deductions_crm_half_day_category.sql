-- Deductions: a "Half Day (CRM)" category (owner, 2026-10-08).
--
-- A district manager or medical rep who worked only the morning or only the afternoon of a field
-- day (Saturday to Wednesday) and left the other half with nothing behind it: no visit, no GPS
-- check-in, no approved vacation for that half, no approved plan item, no pending request. Each
-- such half is its own candidate at 0.5 of a day, charged only once the Super Admin sets it
-- "Approved for Payroll", and paid through the CRM salary column.
--
-- Additive only. The category CHECK gains one value, the new row slots in at sort order 3 beside
-- CRM, and the categories after it move down one place. No candidate, decision or publication row
-- is touched; the FKs from deductions_candidates, deductions_publication_lines and
-- daily_deductions_lines reference deductions_categories(category), so the row must exist before
-- the first half-day candidate is written.

alter table public.deductions_categories
  drop constraint if exists deductions_categories_category_check;

alter table public.deductions_categories
  add constraint deductions_categories_category_check check (
    category = any (array[
      'fingerprint'::text,
      'crm'::text,
      'crm_half_day'::text,
      'no_records_activity'::text,
      'unpaid_vacation'::text,
      'insufficient_balance_vacation'::text,
      'loan'::text,
      'other'::text
    ])
  );

-- Make room at 3 for the new tab, beside CRM. Guarded so a re-run does not shift twice.
update public.deductions_categories
   set sort_order = sort_order + 1
 where sort_order >= 3
   and not exists (select 1 from public.deductions_categories where category = 'crm_half_day');

insert into public.deductions_categories
  (category, label, detection_engine, requires_approval, salary_records_column, sort_order)
values
  ('crm_half_day', 'Half Day (CRM)', 'crm_half_day', true, 'crm', 3)
on conflict (category) do nothing;
