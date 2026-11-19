-- late_expense_reservations_replace_atomically
--
-- WHAT THIS CHANGES: one new function, phx_reserve_late_expenses(p_run_id uuid, p_expense_ids uuid[]). It replaces a
--   payroll run's late-trip reservations in ONE transaction: it deletes the run's earlier rows in
--   automated_payroll_carried_expenses and inserts one row per trip the Part 2 confirm records. If the insert fails —
--   a trip another run reserved a moment ago (the table's primary key on expense_id answers 23505), or any other
--   error — the delete rolls back with it, so the run keeps the reservations it had.
-- WHY: REC-038 close-out, 19 Nov 2026 (owner: "make the late-trip reservation one step"; money-integrity close-out §5
--   item 2). reserveLateExpenses (src/lib/automated-payroll/late-expenses.ts) released the run's earlier
--   reservations and then inserted the new ones as two separate calls, so a failed insert left the earlier rows gone.
--   The same rows are written; nothing about which trip is paid, or how much, changes.
-- ROLLBACK: drop function public.phx_reserve_late_expenses(uuid, uuid[]);  and ship the matching code revert —
--   reserveLateExpenses calls it.
--
-- Add-only: no table, column or row changes on apply, and the code live before this change does not call it. The
-- code that ships with it does: without the function, a Part 2 confirm that carries a late trip refuses and changes
-- nothing ("could not be reserved for this run, so nothing was confirmed").
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one new function.

begin;

create or replace function public.phx_reserve_late_expenses(
  p_run_id      uuid,
  p_expense_ids uuid[]
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_reserved integer := 0;
begin
  -- The run's earlier reservations are replaced, never added to: a confirm records exactly the trips it carries.
  delete from public.automated_payroll_carried_expenses
   where run_id = p_run_id;

  -- One row per trip; expense_id is the primary key, so a trip another run holds refuses here (23505) and the delete
  -- above is undone with it.
  if coalesce(array_length(p_expense_ids, 1), 0) > 0 then
    insert into public.automated_payroll_carried_expenses (expense_id, run_id)
    select distinct trip_id, p_run_id
      from unnest(p_expense_ids) as trip_id;
    get diagnostics v_reserved = row_count;
  end if;

  return v_reserved;
end;
$$;

comment on function public.phx_reserve_late_expenses(uuid, uuid[]) is
  'Replaces a payroll run''s late-trip reservations (automated_payroll_carried_expenses) with the trips its Part 2 confirm records, in one transaction: a failed insert keeps the earlier reservations (REC-038, 19 Nov 2026).';

revoke execute on function public.phx_reserve_late_expenses(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.phx_reserve_late_expenses(uuid, uuid[]) to service_role;

commit;
