-- Trigger functions should not be callable through the Data API/RPC surface.
-- They continue to work when invoked by their owning database trigger.
do $$
begin
  if to_regprocedure('public.phx_terminal_employee_vacancy_guard_trigger()') is not null then
    revoke all on function public.phx_terminal_employee_vacancy_guard_trigger()
      from public, anon, authenticated;
  end if;
end $$;
