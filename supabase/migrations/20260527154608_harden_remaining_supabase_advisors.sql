-- Harden the remaining Supabase security advisor findings.
-- This migration is intentionally conditional so it can run safely across
-- production, staging, and local databases that may not share every object.

do $$
declare
  function_signature text;
  target_function regprocedure;
  target_functions text[] := array[
    'public.email_templates_set_updated_at()',
    'public.employee_support_requests_touch()',
    'public.fill_salary_allowances()',
    'public.fn_get_admin_command_center_data(text, text, text)',
    'public.fn_get_audit_module_counts()',
    'public.fn_get_broken_auth_accounts()',
    'public.fn_get_command_center_metrics()',
    'public.fn_get_employee_directory_paginated(text, bigint, bigint, bigint, bigint, text, integer, integer, text, text, text)',
    'public.fn_get_employee_hierarchy(text)',
    'public.phx_leave_available(numeric, numeric, numeric, numeric, numeric, numeric)',
    'public.phx_prevent_terminal_employee_reactivation()',
    'public.protect_base_salary()',
    'public.set_coaching_updated_at()',
    'public.touch_updated_at()'
  ];
begin
  foreach function_signature in array target_functions
  loop
    target_function := to_regprocedure(function_signature);

    if target_function is not null then
      execute format('alter function %s set search_path = public, pg_temp', target_function);
    end if;
  end loop;
end $$;

do $$
begin
  if to_regclass('public.call_logs') is not null then
    alter table public.call_logs enable row level security;
    drop policy if exists public_call_logs on public.call_logs;
    revoke all on table public.call_logs from anon, authenticated;
    grant all on table public.call_logs to service_role;
  end if;

  if to_regclass('public.customers') is not null then
    alter table public.customers enable row level security;
    drop policy if exists public_customers on public.customers;
    revoke all on table public.customers from anon, authenticated;
    grant all on table public.customers to service_role;
  end if;

  if to_regclass('public.orders') is not null then
    alter table public.orders enable row level security;
    drop policy if exists public_orders on public.orders;
    revoke all on table public.orders from anon, authenticated;
    grant all on table public.orders to service_role;
  end if;

  if to_regclass('public.upload_batches') is not null then
    alter table public.upload_batches enable row level security;
    drop policy if exists public_uploads on public.upload_batches;
    revoke all on table public.upload_batches from anon, authenticated;
    grant all on table public.upload_batches to service_role;
  end if;
end $$;
