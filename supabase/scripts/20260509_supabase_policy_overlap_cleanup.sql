-- Follow-up cleanup for redundant permissive SELECT policies.
-- These policies are subsumed by broader authenticated policies that already
-- preserve the same effective access semantics.

drop policy if exists departments_admin_read
on public.departments;

drop policy if exists employees_select_own_hr
on public.employees;

drop policy if exists "employee can see own expenses"
on public.payroll_expenses;

drop policy if exists salary_batches_hr_admin_read
on public.salary_batches;

drop policy if exists "employee can see own salary"
on public.salary_records;

drop policy if exists "employee can see own sales"
on public.sales_records;

drop policy if exists uap_select_own
on public.user_access_profiles;
