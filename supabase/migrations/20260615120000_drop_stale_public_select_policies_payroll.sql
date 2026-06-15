-- Remove stale {public} role SELECT policies that grant unrestricted read access
-- to all rows in payroll_expenses and salary_batches.
-- The correct scoped policies (payroll_expenses_select_access and
-- salary_batches_select_access) on the {authenticated} role remain in place.
DROP POLICY IF EXISTS "employee can see own expenses" ON public.payroll_expenses;
DROP POLICY IF EXISTS "salary_batches_hr_admin_read" ON public.salary_batches;
