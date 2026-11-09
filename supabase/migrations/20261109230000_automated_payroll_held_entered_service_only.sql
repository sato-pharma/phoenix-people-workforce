-- automated_payroll_held_entered_service_only — take the signed-in-user grant off the held-amount ledger.
--
-- WHAT THIS CHANGES: revokes every privilege `authenticated` holds on public.automated_payroll_held_entered
--   (the table 20261109085429_automated_payroll_held_entered.sql created with select, insert, update and
--   delete granted to it). anon and public stay revoked; service_role keeps `all`.
-- WHY: the table is a payroll-debt ledger — a row here creates a debt the Held Salary Release step collects.
--   Every read and write the app makes goes through the service client (getSupabaseAdmin in
--   src/lib/automated-payroll/held-settlements.ts, three call sites), behind assertPermission in the route,
--   so the `authenticated` grant is never used. With it in place, access to the ledger is only as strong
--   as the four admin policies (current_access_can_manage_employees()); without it, a signed-in browser
--   session has no path to the table at all. The four policies stay: with no grant they are inert, and
--   re-granting would bring them back into force.
-- ROLLBACK: grant select, insert, update, delete on table public.automated_payroll_held_entered to authenticated;
--   Nothing is lost either way: the grant removes a path, it holds no data.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

revoke all on table public.automated_payroll_held_entered from authenticated;

commit;
