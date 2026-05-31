-- Refine authenticated write policies created by the RLS advisory closure.
-- The first closure migration used a few authenticated FOR ALL policies, which
-- is correct but creates duplicate permissive SELECT advisor warnings when a
-- separate read policy exists. Split those into insert/update/delete policies.

drop policy if exists user_access_profiles_write_super_admin on public.user_access_profiles;
drop policy if exists user_access_profiles_insert_super_admin on public.user_access_profiles;
create policy user_access_profiles_insert_super_admin
  on public.user_access_profiles
  for insert
  to authenticated
  with check (private.phx_current_scope() = 'SUPER_ADMIN');

drop policy if exists user_access_profiles_update_super_admin on public.user_access_profiles;
create policy user_access_profiles_update_super_admin
  on public.user_access_profiles
  for update
  to authenticated
  using (private.phx_current_scope() = 'SUPER_ADMIN')
  with check (private.phx_current_scope() = 'SUPER_ADMIN');

drop policy if exists user_access_profiles_delete_super_admin on public.user_access_profiles;
create policy user_access_profiles_delete_super_admin
  on public.user_access_profiles
  for delete
  to authenticated
  using (private.phx_current_scope() = 'SUPER_ADMIN');

drop policy if exists employees_write_hr on public.employees;
drop policy if exists employees_insert_hr on public.employees;
create policy employees_insert_hr
  on public.employees
  for insert
  to authenticated
  with check (private.phx_can_manage_workforce());

drop policy if exists employees_update_hr on public.employees;
create policy employees_update_hr
  on public.employees
  for update
  to authenticated
  using (private.phx_can_manage_workforce())
  with check (private.phx_can_manage_workforce());

drop policy if exists employees_delete_hr on public.employees;
create policy employees_delete_hr
  on public.employees
  for delete
  to authenticated
  using (private.phx_can_manage_workforce());

drop policy if exists employee_compensation_write_payroll on public.employee_compensation;
drop policy if exists employee_compensation_insert_payroll on public.employee_compensation;
create policy employee_compensation_insert_payroll
  on public.employee_compensation
  for insert
  to authenticated
  with check (private.phx_can_manage_payroll());

drop policy if exists employee_compensation_update_payroll on public.employee_compensation;
create policy employee_compensation_update_payroll
  on public.employee_compensation
  for update
  to authenticated
  using (private.phx_can_manage_payroll())
  with check (private.phx_can_manage_payroll());

drop policy if exists employee_compensation_delete_payroll on public.employee_compensation;
create policy employee_compensation_delete_payroll
  on public.employee_compensation
  for delete
  to authenticated
  using (private.phx_can_manage_payroll());

drop policy if exists salary_records_write_payroll on public.salary_records;
drop policy if exists salary_records_insert_payroll on public.salary_records;
create policy salary_records_insert_payroll
  on public.salary_records
  for insert
  to authenticated
  with check (private.phx_can_manage_payroll());

drop policy if exists salary_records_update_payroll on public.salary_records;
create policy salary_records_update_payroll
  on public.salary_records
  for update
  to authenticated
  using (private.phx_can_manage_payroll())
  with check (private.phx_can_manage_payroll());

drop policy if exists salary_records_delete_payroll on public.salary_records;
create policy salary_records_delete_payroll
  on public.salary_records
  for delete
  to authenticated
  using (private.phx_can_manage_payroll());

drop policy if exists salary_batches_write_payroll on public.salary_batches;
drop policy if exists salary_batches_insert_payroll on public.salary_batches;
create policy salary_batches_insert_payroll
  on public.salary_batches
  for insert
  to authenticated
  with check (private.phx_can_manage_payroll());

drop policy if exists salary_batches_update_payroll on public.salary_batches;
create policy salary_batches_update_payroll
  on public.salary_batches
  for update
  to authenticated
  using (private.phx_can_manage_payroll())
  with check (private.phx_can_manage_payroll());

drop policy if exists salary_batches_delete_payroll on public.salary_batches;
create policy salary_batches_delete_payroll
  on public.salary_batches
  for delete
  to authenticated
  using (private.phx_can_manage_payroll());

drop policy if exists salary_flags_write_payroll on public.salary_flags;
drop policy if exists salary_flags_insert_payroll on public.salary_flags;
create policy salary_flags_insert_payroll
  on public.salary_flags
  for insert
  to authenticated
  with check (private.phx_can_manage_payroll());

drop policy if exists salary_flags_update_payroll on public.salary_flags;
create policy salary_flags_update_payroll
  on public.salary_flags
  for update
  to authenticated
  using (private.phx_can_manage_payroll())
  with check (private.phx_can_manage_payroll());

drop policy if exists salary_flags_delete_payroll on public.salary_flags;
create policy salary_flags_delete_payroll
  on public.salary_flags
  for delete
  to authenticated
  using (private.phx_can_manage_payroll());

drop policy if exists payroll_expense_reports_write_payroll on public.payroll_expense_reports;
drop policy if exists payroll_expense_reports_insert_payroll on public.payroll_expense_reports;
create policy payroll_expense_reports_insert_payroll
  on public.payroll_expense_reports
  for insert
  to authenticated
  with check (private.phx_can_manage_payroll());

drop policy if exists payroll_expense_reports_update_payroll on public.payroll_expense_reports;
create policy payroll_expense_reports_update_payroll
  on public.payroll_expense_reports
  for update
  to authenticated
  using (private.phx_can_manage_payroll())
  with check (private.phx_can_manage_payroll());

drop policy if exists payroll_expense_reports_delete_payroll on public.payroll_expense_reports;
create policy payroll_expense_reports_delete_payroll
  on public.payroll_expense_reports
  for delete
  to authenticated
  using (private.phx_can_manage_payroll());

notify pgrst, 'reload schema';
