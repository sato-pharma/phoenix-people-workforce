-- employee_change_log_shares_the_audit_trail_refusal — one append-only refusal, not two
--
-- WHAT THIS CHANGES:
--   * public.phx_refuse_audit_trail_change() — its message and hint are worded for every
--     append-only history, not only payroll's decision trails. Same behaviour: it raises on
--     UPDATE, DELETE and TRUNCATE. Its search_path (public, pg_temp, set later by ALTER) is restated
--     here, because a CREATE OR REPLACE without a SET clause would remove it.
--   * The three refusal triggers on public.employee_change_log now call it. They are replaced in
--     place (CREATE OR REPLACE TRIGGER, same names) and set ENABLE ALWAYS again, so the log is never
--     without its guard, not even inside this transaction.
--   * public.phx_refuse_history_change() — dropped. 20261113151738 made it as a copy of the function
--     above, and nothing else calls it (read on production 2026-11-14: its only triggers were the
--     three above).
--
-- WHY: the code review of 2026-11-14 — two functions with the same body and the same job drift
--   apart, and a later change to append-only behaviour would have to be made twice.
--
-- ROLLBACK: re-run the phx_refuse_history_change() block and the three create trigger statements
--   from 20261113151738, and the phx_refuse_audit_trail_change() body from
--   20260912010000_payroll_audit_trail_append_only.sql (with `set search_path = public, pg_temp`).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: it replaces one function and three triggers, and drops a
-- function nothing calls. No row is written.

begin;

create or replace function public.phx_refuse_audit_trail_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception
    'The % history is append-only. % is refused.',
    tg_table_name, tg_op
    using hint =
      'A history row records what happened, and payroll''s and deductions'' trails are the record '
      'behind real payments. Supersede a wrong one with a NEW row. To remove one, drop this '
      'trigger deliberately in a migration, with the owner told first.';
  return null;  -- unreachable; kept so the row-level signature stays honest
end;
$$;

comment on function public.phx_refuse_audit_trail_change() is
  'Refuses UPDATE, DELETE and TRUNCATE on an append-only history: automated_payroll_audit, '
  'deductions_audit and employee_change_log. Binds the table owner, which a REVOKE does not.';

create or replace trigger employee_change_log_no_update before update on public.employee_change_log
  for each row execute function public.phx_refuse_audit_trail_change();
create or replace trigger employee_change_log_no_delete before delete on public.employee_change_log
  for each row execute function public.phx_refuse_audit_trail_change();
-- TRUNCATE fires no row trigger, so it needs a statement-level one of its own.
create or replace trigger employee_change_log_no_truncate before truncate on public.employee_change_log
  for each statement execute function public.phx_refuse_audit_trail_change();
alter table public.employee_change_log enable always trigger employee_change_log_no_update;
alter table public.employee_change_log enable always trigger employee_change_log_no_delete;
alter table public.employee_change_log enable always trigger employee_change_log_no_truncate;

drop function if exists public.phx_refuse_history_change();

commit;

-- Timestamp 20261114021603 was minted to sort after every migration already on main.
