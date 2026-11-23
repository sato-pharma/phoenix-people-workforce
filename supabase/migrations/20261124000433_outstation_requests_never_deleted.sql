-- WHAT: An expense request is never deleted. A BEFORE DELETE (each row) and a BEFORE TRUNCATE trigger on
--       public.outstation_expense_requests refuse the statement, whoever runs it (the app's service role
--       included).
-- WHY:  Owner, 24 Nov 2026, about 00:05 Cairo: "never delete any expense request. If rejected, keep them as
--       rejected, but never delete." The app's one delete path (the admin delete behind two routes and the
--       System Cleanup Center) is removed in the same pull request; this makes the database say the same,
--       so no script, route or later change can remove a request in silence. Six requests were deleted
--       that way between 7 Jun and 10 Oct 2026 (the audit rows "Admin deleted outstation request …").
--       Not guarded on purpose: public.expense_claims, the hourly mirror phx_refresh_expense_claims deletes
--       and rebuilds; payroll_copilot_expense_decisions (its foreign key cascades, which now never fires).
-- ROLLBACK:
--   drop trigger if exists phx_outstation_requests_never_deleted on public.outstation_expense_requests;
--   drop trigger if exists phx_outstation_requests_never_truncated on public.outstation_expense_requests;
--   drop function if exists public.phx_outstation_requests_never_deleted();
--   No data changes; nothing to restore.

create or replace function public.phx_outstation_requests_never_deleted()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'expense requests are never deleted; reject the request instead (a rejected request stays on the record)'
    using errcode = 'P0001',
          hint = 'Owner rule, 24 Nov 2026: never delete an expense request. Reject it.';
end;
$$;

comment on function public.phx_outstation_requests_never_deleted() is
  'Refuses every DELETE and TRUNCATE on outstation_expense_requests. Owner, 24 Nov 2026: "never delete any expense request. If rejected, keep them as rejected, but never delete."';

revoke execute on function public.phx_outstation_requests_never_deleted() from public, anon, authenticated;
grant execute on function public.phx_outstation_requests_never_deleted() to service_role;

drop trigger if exists phx_outstation_requests_never_deleted on public.outstation_expense_requests;
create trigger phx_outstation_requests_never_deleted
  before delete on public.outstation_expense_requests
  for each row execute function public.phx_outstation_requests_never_deleted();

drop trigger if exists phx_outstation_requests_never_truncated on public.outstation_expense_requests;
create trigger phx_outstation_requests_never_truncated
  before truncate on public.outstation_expense_requests
  for each statement execute function public.phx_outstation_requests_never_deleted();
