-- Resolve remaining multiple_permissive_policies findings by separating
-- read policies from write policies and consolidating self/admin mutations.

-- ---------------------------------------------------------------------------
-- employee_compensation
-- ---------------------------------------------------------------------------

drop policy if exists employee_compensation_dynamic_read
on public.employee_compensation;

create policy employee_compensation_select_access
on public.employee_compensation
for select
to authenticated
using (
  current_access_can_manage_employees()
  or current_access_is_admin()
  or lower(coalesce(employee_hr_id, '')) = lower(coalesce(current_access_hr_id(), ''))
  or exists (
    select 1
    from public.employees e
    where lower(e.hr_id) = lower(employee_compensation.employee_hr_id)
      and current_access_can_see_employee(e.hr_id, e.manager_hr_id)
  )
);

drop policy if exists employee_compensation_hr_admin_write
on public.employee_compensation;

create policy employee_compensation_admin_insert
on public.employee_compensation
for insert
to authenticated
with check (current_access_can_manage_employees());

create policy employee_compensation_admin_update
on public.employee_compensation
for update
to authenticated
using (current_access_can_manage_employees())
with check (current_access_can_manage_employees());

create policy employee_compensation_admin_delete
on public.employee_compensation
for delete
to authenticated
using (current_access_can_manage_employees());

-- ---------------------------------------------------------------------------
-- employees
-- ---------------------------------------------------------------------------

drop policy if exists employees_hr_admin_write
on public.employees;

drop policy if exists employees_insert_own_hr
on public.employees;

drop policy if exists employees_update_own_hr
on public.employees;

drop policy if exists employees_delete_own_hr
on public.employees;

create policy employees_insert_self_or_admin
on public.employees
for insert
to authenticated
with check (
  current_access_can_manage_employees()
  or hr_id = (
    select u.hr_id
    from public.users u
    where u.id = (select auth.uid())
  )
);

create policy employees_update_self_or_admin
on public.employees
for update
to authenticated
using (
  current_access_can_manage_employees()
  or hr_id = (
    select u.hr_id
    from public.users u
    where u.id = (select auth.uid())
  )
)
with check (
  current_access_can_manage_employees()
  or hr_id = (
    select u.hr_id
    from public.users u
    where u.id = (select auth.uid())
  )
);

create policy employees_delete_self_or_admin
on public.employees
for delete
to authenticated
using (
  current_access_can_manage_employees()
  or hr_id = (
    select u.hr_id
    from public.users u
    where u.id = (select auth.uid())
  )
);

-- ---------------------------------------------------------------------------
-- payroll_expense_reports
-- ---------------------------------------------------------------------------

drop policy if exists payroll_expense_reports_dynamic_read
on public.payroll_expense_reports;

create policy payroll_expense_reports_select_access
on public.payroll_expense_reports
for select
to authenticated
using (
  current_access_role() = any (array['admin'::text, 'hr'::text, 'manager'::text])
  or current_access_is_admin()
  or exists (
    select 1
    from public.payroll_expenses pe
    where pe.report_id = payroll_expense_reports.id
  )
);

drop policy if exists payroll_expense_reports_hr_admin_write
on public.payroll_expense_reports;

create policy payroll_expense_reports_admin_insert
on public.payroll_expense_reports
for insert
to authenticated
with check (current_access_role() = any (array['admin'::text, 'hr'::text, 'manager'::text]));

create policy payroll_expense_reports_admin_update
on public.payroll_expense_reports
for update
to authenticated
using (current_access_role() = any (array['admin'::text, 'hr'::text, 'manager'::text]))
with check (current_access_role() = any (array['admin'::text, 'hr'::text, 'manager'::text]));

create policy payroll_expense_reports_admin_delete
on public.payroll_expense_reports
for delete
to authenticated
using (current_access_role() = any (array['admin'::text, 'hr'::text, 'manager'::text]));

-- ---------------------------------------------------------------------------
-- payroll_expenses
-- ---------------------------------------------------------------------------

drop policy if exists payroll_expenses_dynamic_read
on public.payroll_expenses;

create policy payroll_expenses_select_access
on public.payroll_expenses
for select
to authenticated
using (
  current_access_role() = any (array['admin'::text, 'hr'::text, 'manager'::text])
  or current_access_is_admin()
  or lower(coalesce(hr_id, '')) = lower(coalesce(current_access_hr_id(), ''))
  or exists (
    select 1
    from public.employees e
    where lower(e.hr_id) = lower(payroll_expenses.hr_id)
      and current_access_can_see_employee(e.hr_id, e.manager_hr_id)
  )
);

drop policy if exists payroll_expenses_hr_admin_write
on public.payroll_expenses;

create policy payroll_expenses_admin_insert
on public.payroll_expenses
for insert
to authenticated
with check (current_access_role() = any (array['admin'::text, 'hr'::text, 'manager'::text]));

create policy payroll_expenses_admin_update
on public.payroll_expenses
for update
to authenticated
using (current_access_role() = any (array['admin'::text, 'hr'::text, 'manager'::text]))
with check (current_access_role() = any (array['admin'::text, 'hr'::text, 'manager'::text]));

create policy payroll_expenses_admin_delete
on public.payroll_expenses
for delete
to authenticated
using (current_access_role() = any (array['admin'::text, 'hr'::text, 'manager'::text]));

-- ---------------------------------------------------------------------------
-- salary_batches
-- ---------------------------------------------------------------------------

drop policy if exists salary_batches_dynamic_read
on public.salary_batches;

create policy salary_batches_select_access
on public.salary_batches
for select
to authenticated
using (
  current_access_can_manage_employees()
  or current_access_is_admin()
  or exists (
    select 1
    from public.salary_records sr
    where sr.batch_id = salary_batches.id
  )
);

drop policy if exists salary_batches_hr_admin_write
on public.salary_batches;

create policy salary_batches_admin_insert
on public.salary_batches
for insert
to authenticated
with check (current_access_can_manage_employees());

create policy salary_batches_admin_update
on public.salary_batches
for update
to authenticated
using (current_access_can_manage_employees())
with check (current_access_can_manage_employees());

create policy salary_batches_admin_delete
on public.salary_batches
for delete
to authenticated
using (current_access_can_manage_employees());

-- ---------------------------------------------------------------------------
-- salary_flags
-- ---------------------------------------------------------------------------

drop policy if exists salary_flags_dynamic_read
on public.salary_flags;

create policy salary_flags_select_access
on public.salary_flags
for select
to authenticated
using (
  current_access_can_manage_employees()
  or current_access_is_admin()
  or (
    hr_id is not null
    and lower(coalesce(hr_id, '')) = lower(coalesce(current_access_hr_id(), ''))
  )
  or exists (
    select 1
    from public.salary_records sr
    where sr.batch_id = salary_flags.batch_id
      and lower(coalesce(sr.hr_id, '')) = lower(coalesce(salary_flags.hr_id, ''))
  )
);

drop policy if exists salary_flags_hr_admin_write
on public.salary_flags;

create policy salary_flags_admin_insert
on public.salary_flags
for insert
to authenticated
with check (current_access_can_manage_employees());

create policy salary_flags_admin_update
on public.salary_flags
for update
to authenticated
using (current_access_can_manage_employees())
with check (current_access_can_manage_employees());

create policy salary_flags_admin_delete
on public.salary_flags
for delete
to authenticated
using (current_access_can_manage_employees());

-- ---------------------------------------------------------------------------
-- salary_records
-- ---------------------------------------------------------------------------

drop policy if exists salary_records_dynamic_read
on public.salary_records;

create policy salary_records_select_access
on public.salary_records
for select
to authenticated
using (
  current_access_can_manage_employees()
  or current_access_is_admin()
  or lower(coalesce(hr_id, '')) = lower(coalesce(current_access_hr_id(), ''))
  or exists (
    select 1
    from public.employees e
    where lower(e.hr_id) = lower(salary_records.hr_id)
      and current_access_can_see_employee(e.hr_id, e.manager_hr_id)
  )
);

drop policy if exists salary_records_hr_admin_write
on public.salary_records;

create policy salary_records_admin_insert
on public.salary_records
for insert
to authenticated
with check (current_access_can_manage_employees());

create policy salary_records_admin_update
on public.salary_records
for update
to authenticated
using (current_access_can_manage_employees())
with check (current_access_can_manage_employees());

create policy salary_records_admin_delete
on public.salary_records
for delete
to authenticated
using (current_access_can_manage_employees());

-- ---------------------------------------------------------------------------
-- sales_records
-- ---------------------------------------------------------------------------

drop policy if exists sales_records_dynamic_read
on public.sales_records;

create policy sales_records_select_access
on public.sales_records
for select
to authenticated
using (
  current_access_role() = any (array['admin'::text, 'hr'::text])
  or current_access_is_admin()
  or lower(coalesce(employee_hr_id, '')) = lower(coalesce(current_access_hr_id(), ''))
  or lower(coalesce(manager_hr_id, '')) = lower(coalesce(current_access_hr_id(), ''))
);

drop policy if exists sales_records_hr_admin_write
on public.sales_records;

create policy sales_records_admin_insert
on public.sales_records
for insert
to authenticated
with check (current_access_role() = any (array['admin'::text, 'hr'::text]));

create policy sales_records_admin_update
on public.sales_records
for update
to authenticated
using (current_access_role() = any (array['admin'::text, 'hr'::text]))
with check (current_access_role() = any (array['admin'::text, 'hr'::text]));

create policy sales_records_admin_delete
on public.sales_records
for delete
to authenticated
using (current_access_role() = any (array['admin'::text, 'hr'::text]));

-- ---------------------------------------------------------------------------
-- user_access_profiles
-- ---------------------------------------------------------------------------

drop policy if exists user_access_profiles_admin_write
on public.user_access_profiles;

drop policy if exists uap_update_own
on public.user_access_profiles;

create policy user_access_profiles_admin_insert
on public.user_access_profiles
for insert
to authenticated
with check (current_access_role() = 'admin'::text);

create policy user_access_profiles_update_self_or_admin
on public.user_access_profiles
for update
to authenticated
using (
  current_access_role() = 'admin'::text
  or auth_user_id = (select auth.uid())
)
with check (
  current_access_role() = 'admin'::text
  or auth_user_id = (select auth.uid())
);

create policy user_access_profiles_admin_delete
on public.user_access_profiles
for delete
to authenticated
using (current_access_role() = 'admin'::text);
