-- WHAT: An expense request is deleted only by the owner's own press, never automatically. Adds the one door a
--       request row leaves through, public.phx_owner_delete_outstation_request(p_request_id), and changes the
--       trigger function phx_outstation_requests_never_deleted (from 20261124000433) so it lets a DELETE through
--       only when that door opened it. A plain DELETE from anything else, and any TRUNCATE, is still refused.
-- WHY:  Owner, 24 Nov 2026, about 01:20 Cairo, correcting the first rule: "leave the delete the button i meant u
--       never delete automatic only i from system can delete". The app calls the door only from
--       deleteOutstationRequestAsAdmin, after assertOwnerDeletesRequest (a real signed-in Super Admin session:
--       never a system context, a preview, a View as Seat or a test account) — Delete expense on Outstation
--       Requests, or the System Cleanup Center.
-- ROLLBACK:
--   drop function if exists public.phx_owner_delete_outstation_request(bigint);
--   then re-run 20261124000433_outstation_requests_never_deleted.sql (refuses every delete again), or
--   drop the two triggers it created. No data changes; nothing to restore.

create or replace function public.phx_outstation_requests_never_deleted()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('phx.owner_request_delete', true), '') = 'on' then
    return old;
  end if;
  raise exception 'expense requests are never deleted automatically; only the Super Admin deletes one, from the app'
    using errcode = 'P0001',
          hint = 'Owner rule, 24 Nov 2026: only he deletes an expense request, by his own press. Reject it otherwise.';
end;
$$;

comment on function public.phx_outstation_requests_never_deleted() is
  'Refuses every DELETE on outstation_expense_requests except through phx_owner_delete_outstation_request, and every TRUNCATE. Owner, 24 Nov 2026: "never delete automatic only i from system can delete".';

create or replace function public.phx_owner_delete_outstation_request(p_request_id bigint)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_deleted integer;
begin
  perform set_config('phx.owner_request_delete', 'on', true);
  delete from public.outstation_expense_requests where id = p_request_id;
  get diagnostics v_deleted = row_count;
  perform set_config('phx.owner_request_delete', '', true);
  return v_deleted;
end;
$$;

comment on function public.phx_owner_delete_outstation_request(bigint) is
  'The one door an expense request leaves through. Called only by deleteOutstationRequestAsAdmin after assertOwnerDeletesRequest (the Super Admin''s own press).';

revoke execute on function public.phx_owner_delete_outstation_request(bigint) from public, anon, authenticated;
grant execute on function public.phx_owner_delete_outstation_request(bigint) to service_role;
