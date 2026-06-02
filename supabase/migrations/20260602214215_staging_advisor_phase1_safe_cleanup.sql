-- Supabase advisor Phase 1 cleanup.
--
-- Scope:
-- - pin search_path for advisor-reported functions;
-- - remove direct Data API/RPC execution from dangerous SECURITY DEFINER
--   functions and trigger functions;
-- - keep current_access_* helpers unchanged for the later RLS helper refactor.
--
-- This migration is intentionally conditional so it can run safely against
-- staging/local environments whose historical advisor state may differ.

begin;

do $$
declare
  v_signature text;
  v_fn regprocedure;
  v_public_path text[] := array[
    'public.set_coaching_updated_at()',
    'public.employee_support_requests_touch()',
    'public.phx_coaching_item_definition(text)',
    'public.phx_coaching_zone(numeric)'
  ];
  v_private_path text[] := array[
    'private.phx_exec_source(text, text)'
  ];
begin
  foreach v_signature in array v_public_path
  loop
    v_fn := to_regprocedure(v_signature);
    if v_fn is not null then
      execute format('alter function %s set search_path = public, pg_temp', v_fn);
    end if;
  end loop;

  foreach v_signature in array v_private_path
  loop
    v_fn := to_regprocedure(v_signature);
    if v_fn is not null then
      execute format('alter function %s set search_path = public, private, pg_temp', v_fn);
    end if;
  end loop;
end $$;

do $$
declare
  v_signature text;
  v_fn regprocedure;
  v_locked_functions text[] := array[
    'public.rls_auto_enable()',
    'public.trg_employees_manager_history_fn()',
    'public.trg_salary_record_eligibility_fn()'
  ];
begin
  foreach v_signature in array v_locked_functions
  loop
    v_fn := to_regprocedure(v_signature);
    if v_fn is not null then
      execute format('revoke execute on function %s from public, anon, authenticated', v_fn);
    end if;
  end loop;
end $$;

do $$
declare
  v_fn regprocedure;
begin
  v_fn := to_regprocedure(
    'public.phx_resign_employee_and_open_vacancy(text, date, date, text, text, text, text, text, text)'
  );

  if v_fn is not null then
    execute format('revoke execute on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
