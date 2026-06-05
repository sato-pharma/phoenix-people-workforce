do $$
declare
  v_fn regprocedure;
begin
  select to_regprocedure('public.accept_offer_and_create_employee(uuid, text, date, date, date, date, date)') into v_fn;
  if v_fn is not null then
    revoke execute on function public.accept_offer_and_create_employee(uuid, text, date, date, date, date, date) from public, anon, authenticated;
  end if;

  select to_regprocedure('public.create_lifecycle_notification_event(text, text, date, text, jsonb)') into v_fn;
  if v_fn is not null then
    revoke execute on function public.create_lifecycle_notification_event(text, text, date, text, jsonb) from public, anon, authenticated;
  end if;

  select to_regprocedure('public.current_access_can_manage_employees()') into v_fn;
  if v_fn is not null then
    revoke execute on function public.current_access_can_manage_employees() from public, anon, authenticated;
  end if;

  select to_regprocedure('public.current_access_can_see_employee(text, text)') into v_fn;
  if v_fn is not null then
    revoke execute on function public.current_access_can_see_employee(text, text) from public, anon, authenticated;
  end if;

  select to_regprocedure('public.current_access_hr_id()') into v_fn;
  if v_fn is not null then
    revoke execute on function public.current_access_hr_id() from public, anon, authenticated;
  end if;

  select to_regprocedure('public.current_access_is_admin()') into v_fn;
  if v_fn is not null then
    revoke execute on function public.current_access_is_admin() from public, anon, authenticated;
  end if;

  select to_regprocedure('public.current_access_line()') into v_fn;
  if v_fn is not null then
    revoke execute on function public.current_access_line() from public, anon, authenticated;
  end if;

  select to_regprocedure('public.current_access_manager_hr_id()') into v_fn;
  if v_fn is not null then
    revoke execute on function public.current_access_manager_hr_id() from public, anon, authenticated;
  end if;

  select to_regprocedure('public.current_access_role()') into v_fn;
  if v_fn is not null then
    revoke execute on function public.current_access_role() from public, anon, authenticated;
  end if;

  select to_regprocedure('public.current_hr_id()') into v_fn;
  if v_fn is not null then
    revoke execute on function public.current_hr_id() from public, anon, authenticated;
  end if;

  select to_regprocedure('public.finalize_manual_employee_lifecycle(text)') into v_fn;
  if v_fn is not null then
    revoke execute on function public.finalize_manual_employee_lifecycle(text) from public, anon, authenticated;
  end if;

  select to_regprocedure('public.generate_employee_lifecycle_notifications(text)') into v_fn;
  if v_fn is not null then
    revoke execute on function public.generate_employee_lifecycle_notifications(text) from public, anon, authenticated;
  end if;

  select to_regprocedure('public.resign_employee_and_open_vacancy(text, date, date, text, text, text, boolean)') into v_fn;
  if v_fn is not null then
    revoke execute on function public.resign_employee_and_open_vacancy(text, date, date, text, text, text, boolean) from public, anon, authenticated;
  end if;
end $$;
