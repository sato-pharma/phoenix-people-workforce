-- Clean up remaining local Supabase advisor findings after the RLS closure.
-- These are narrow, non-destructive security/performance changes:
-- - split authenticated leave-management FOR ALL policies to avoid duplicate
--   permissive SELECT policies;
-- - drop duplicate indexes where an equivalent canonical index remains;
-- - pin search_path on mutable public functions reported by the advisor.

drop policy if exists employee_leave_balances_manage on public.employee_leave_balances;
drop policy if exists employee_leave_balances_insert_manage on public.employee_leave_balances;
create policy employee_leave_balances_insert_manage
  on public.employee_leave_balances
  for insert
  to authenticated
  with check (private.phx_can_manage_leave());

drop policy if exists employee_leave_balances_update_manage on public.employee_leave_balances;
create policy employee_leave_balances_update_manage
  on public.employee_leave_balances
  for update
  to authenticated
  using (private.phx_can_manage_leave())
  with check (private.phx_can_manage_leave());

drop policy if exists employee_leave_balances_delete_manage on public.employee_leave_balances;
create policy employee_leave_balances_delete_manage
  on public.employee_leave_balances
  for delete
  to authenticated
  using (private.phx_can_manage_leave());

drop policy if exists leave_policies_manage on public.leave_policies;
drop policy if exists leave_policies_insert_manage on public.leave_policies;
create policy leave_policies_insert_manage
  on public.leave_policies
  for insert
  to authenticated
  with check (private.phx_can_manage_leave());

drop policy if exists leave_policies_update_manage on public.leave_policies;
create policy leave_policies_update_manage
  on public.leave_policies
  for update
  to authenticated
  using (private.phx_can_manage_leave())
  with check (private.phx_can_manage_leave());

drop policy if exists leave_policies_delete_manage on public.leave_policies;
create policy leave_policies_delete_manage
  on public.leave_policies
  for delete
  to authenticated
  using (private.phx_can_manage_leave());

drop policy if exists leave_transactions_manage on public.leave_transactions;
drop policy if exists leave_transactions_insert_manage on public.leave_transactions;
create policy leave_transactions_insert_manage
  on public.leave_transactions
  for insert
  to authenticated
  with check (private.phx_can_manage_leave());

drop policy if exists leave_transactions_update_manage on public.leave_transactions;
create policy leave_transactions_update_manage
  on public.leave_transactions
  for update
  to authenticated
  using (private.phx_can_manage_leave())
  with check (private.phx_can_manage_leave());

drop policy if exists leave_transactions_delete_manage on public.leave_transactions;
create policy leave_transactions_delete_manage
  on public.leave_transactions
  for delete
  to authenticated
  using (private.phx_can_manage_leave());

drop policy if exists leave_types_manage on public.leave_types;
drop policy if exists leave_types_insert_manage on public.leave_types;
create policy leave_types_insert_manage
  on public.leave_types
  for insert
  to authenticated
  with check (private.phx_can_manage_leave());

drop policy if exists leave_types_update_manage on public.leave_types;
create policy leave_types_update_manage
  on public.leave_types
  for update
  to authenticated
  using (private.phx_can_manage_leave())
  with check (private.phx_can_manage_leave());

drop policy if exists leave_types_delete_manage on public.leave_types;
create policy leave_types_delete_manage
  on public.leave_types
  for delete
  to authenticated
  using (private.phx_can_manage_leave());

drop policy if exists public_holidays_manage on public.public_holidays;
drop policy if exists public_holidays_insert_manage on public.public_holidays;
create policy public_holidays_insert_manage
  on public.public_holidays
  for insert
  to authenticated
  with check (private.phx_can_manage_leave());

drop policy if exists public_holidays_update_manage on public.public_holidays;
create policy public_holidays_update_manage
  on public.public_holidays
  for update
  to authenticated
  using (private.phx_can_manage_leave())
  with check (private.phx_can_manage_leave());

drop policy if exists public_holidays_delete_manage on public.public_holidays;
create policy public_holidays_delete_manage
  on public.public_holidays
  for delete
  to authenticated
  using (private.phx_can_manage_leave());

drop index if exists public.idx_employee_contracts_hr_id;
drop index if exists public.idx_sales_targets_employee_hr_id;
drop index if exists public.idx_sales_targets_manager_hr_id;

do $$
declare
  v_fn regprocedure;
  v_signature text;
  v_signatures text[] := array[
    'public.phx_contract_note(text, text, text, text)',
    'public.phx_create_marketing_request_draft_atomic(jsonb)',
    'public.trg_employees_manager_history_fn()',
    'public.trg_salary_record_eligibility_fn()',
    'public.trg_vacation_weekly_off_policies_updated_at_fn()',
    'public.workflow_versions_block_mutation()'
  ];
begin
  foreach v_signature in array v_signatures
  loop
    v_fn := to_regprocedure(v_signature);
    if v_fn is not null then
      execute format('alter function %s set search_path = public, pg_temp', v_fn);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
