-- salary_change_log_refuses_update_delete_truncate — the salary log is append-only, as it always said
--
-- WHAT THIS CHANGES:
--   * Three refusal triggers on public.employee_salary_change_log, exactly as
--     public.employee_change_log has them (20261114021603): BEFORE UPDATE and BEFORE DELETE for each
--     row, BEFORE TRUNCATE for each statement, all calling the one shared
--     public.phx_refuse_audit_trail_change(), and all ENABLE ALWAYS so that
--     session_replication_role = replica does not walk past them.
--   * The comment on public.phx_refuse_audit_trail_change() names this log among the trails it guards.
--     The function's body is not touched.
--
-- WHY: read on 19 Nov 2026, 04:10 Cairo, on both projects (production ozucdzovmcqvepbozvqf and staging
--   cifwmndunmlxjhyjugxa): pg_trigger held NO user trigger on employee_salary_change_log. Yet three
--   places said it refused changes — its own table comment ('Append-only audit of salary changes…'),
--   20261113151741's header and docs/security/recovery-snapshots.md, which leave it out of the hourly
--   undo log BECAUSE "UPDATE, DELETE and TRUNCATE are refused by trigger". No migration ever created
--   those triggers (20260924175023 made the table, 20260929183329 widened its writer to hires, neither
--   added a refusal), so the one trail that holds every salary figure ever set was neither refusing
--   edits nor snapshotted. service_role and postgres both hold UPDATE, DELETE and TRUNCATE on it.
--
-- WHAT WAS CHECKED BEFORE (production, 19 Nov 2026):
--   * Its only writer is public.phx_log_employee_salary_change(), and that body only INSERTs (pg_proc).
--     No other function names the table. No code in src/ writes it; the app reads it through
--     v_employee_salary_change_log.
--   * No foreign key points at it or from it, so no ON DELETE CASCADE can be refused by the new
--     row trigger; deleting an employee is unaffected.
--   * It is not registered in recovery.protected_tables, so recovery.restore_table never writes it.
--   * 73 rows. No row is written, changed or removed here.
--   * One past by-hand act did touch it: the 10 Oct 2026 hr_id rename (OF-0005 to HR-011) updated
--     its employee_hr_id in one DO block. A future rename now leaves this log under the old id, as
--     audit_logs and employee_change_log already are.
--
-- ROLLBACK (only on the owner's word, since this removes the guard on salary history): a new
--   migration that drops the three triggers this file creates — the _no_update, _no_delete and
--   _no_truncate refusals on public.employee_salary_change_log — and re-runs the comment on
--   public.phx_refuse_audit_trail_change() from 20261114021603. The statements are not spelled out
--   here: tests/employee-and-deduction-history.test.ts refuses any later migration whose text drops a
--   guarded history trigger, comments included.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: it adds three triggers and changes one comment.

begin;

create or replace trigger employee_salary_change_log_no_update before update on public.employee_salary_change_log
  for each row execute function public.phx_refuse_audit_trail_change();
create or replace trigger employee_salary_change_log_no_delete before delete on public.employee_salary_change_log
  for each row execute function public.phx_refuse_audit_trail_change();
-- TRUNCATE fires no row trigger, so it needs a statement-level one of its own.
create or replace trigger employee_salary_change_log_no_truncate before truncate on public.employee_salary_change_log
  for each statement execute function public.phx_refuse_audit_trail_change();
alter table public.employee_salary_change_log enable always trigger employee_salary_change_log_no_update;
alter table public.employee_salary_change_log enable always trigger employee_salary_change_log_no_delete;
alter table public.employee_salary_change_log enable always trigger employee_salary_change_log_no_truncate;

comment on function public.phx_refuse_audit_trail_change() is
  'Refuses UPDATE, DELETE and TRUNCATE on an append-only history: automated_payroll_audit, '
  'deductions_audit, employee_change_log and employee_salary_change_log. Binds the table owner, '
  'which a REVOKE does not.';

commit;

-- Timestamp 20261119072427 was minted to sort after every migration already on main.
