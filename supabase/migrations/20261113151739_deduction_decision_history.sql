-- deduction_decision_history — every deduction decision, and every change to one, is kept
--
-- WHAT THIS CHANGES:
--   * public.phx_log_deduction_decision_change() — an AFTER INSERT OR UPDATE ROW trigger on
--     public.deductions_decisions that appends one row to public.deductions_audit whenever a
--     decision is first recorded ('decision_recorded') or one of its deciding columns changes
--     ('decision_changed'). The row carries the decision before and after, the changed column
--     names, and the decider (decided_by) as actor_hr_id.
--   * No new table: deductions_audit is already the module's append-only trail, refused UPDATE,
--     DELETE and TRUNCATE by trigger since 20260912010000_payroll_audit_trail_append_only.sql.
--
-- WHY (enterprise audit 2026-11-13, finding F-PAY-003, recommendation REC-039):
--   A decision is an upsert on deductions_decisions (one row per candidate), so the previous
--   decision is overwritten. The only trail was a generic audit_logs row carrying the new values
--   and never the old ones, written by a helper that swallows its own failures — and audit_logs
--   is pruned at 12 months. Payroll charges the decision, so this is the record that takes money
--   from pay, and "what did it charge before, and who changed it" had no answer. A trigger, so no
--   code path — the screen, the weekly digest, the HR-operations bridge or a repair — can skip it.
--
-- DECIDING COLUMNS: decision_status, decision_reason, hr_note, applied_value, applied_amount,
--   applied_dates, decided_by. A save that changes none of them (a re-save of the same decision,
--   which moves only decided_at and updated_at) records nothing.
--
-- SIDE EFFECTS:
--   * One extra insert per changed decision.
--   * deductions_audit.candidate_id is ON DELETE RESTRICT, so a candidate with a recorded decision
--     can no longer be deleted. Nothing deletes one today — corrections supersede, by design —
--     and every candidate that was ever superseded is already held the same way.
--   * DELETE of a decision is deliberately not logged: a decision row only goes when its candidate
--     is deleted by cascade, and an audit row inserted mid-cascade would refuse that delete.
--
-- ROLLBACK (additive; no existing row is touched):
--   drop trigger if exists phx_deductions_decisions_history on public.deductions_decisions;
--   drop function if exists public.phx_log_deduction_decision_change();
--   The deductions_audit rows it wrote stay: that table is append-only by design.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk.

begin;

create or replace function public.phx_log_deduction_decision_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  deciding constant text[] := array[
    'decision_status', 'decision_reason', 'hr_note',
    'applied_value', 'applied_amount', 'applied_dates', 'decided_by'
  ];
  o       jsonb := '{}'::jsonb;
  n       jsonb := to_jsonb(new);
  col     text;
  fields  text[] := '{}';
  before_ jsonb := '{}'::jsonb;
  after_  jsonb := '{}'::jsonb;
begin
  if tg_op = 'UPDATE' then
    o := to_jsonb(old);
  end if;

  foreach col in array deciding loop
    after_ := after_ || jsonb_build_object(col, n -> col);
    if tg_op = 'UPDATE' then
      before_ := before_ || jsonb_build_object(col, o -> col);
      if (o -> col) is distinct from (n -> col) then
        fields := array_append(fields, col);
      end if;
    elsif jsonb_typeof(n -> col) <> 'null' then
      fields := array_append(fields, col);
    end if;
  end loop;

  if tg_op = 'UPDATE' and array_length(fields, 1) is null then
    return null;
  end if;

  insert into public.deductions_audit (candidate_id, actor_hr_id, action, detail)
  values (
    new.candidate_id,
    new.decided_by,
    case when tg_op = 'INSERT' then 'decision_recorded' else 'decision_changed' end,
    jsonb_build_object(
      'decision_id', new.id,
      'changed_fields', to_jsonb(fields),
      'before', case when tg_op = 'INSERT' then null else before_ end,
      'after', after_,
      'decided_at', new.decided_at,
      'actor_role_at_decision', new.actor_role_at_decision
    )
  );

  return null;
end;
$$;

comment on function public.phx_log_deduction_decision_change() is
  'AFTER INSERT OR UPDATE ROW trigger on public.deductions_decisions: appends the decision before '
  'and after to the append-only public.deductions_audit (actions decision_recorded, '
  'decision_changed).';

revoke execute on function public.phx_log_deduction_decision_change() from public, anon, authenticated;
grant execute on function public.phx_log_deduction_decision_change() to service_role;

drop trigger if exists phx_deductions_decisions_history on public.deductions_decisions;
create trigger phx_deductions_decisions_history
  after insert or update on public.deductions_decisions
  for each row execute function public.phx_log_deduction_decision_change();

commit;

-- Timestamp 20261113151739 was minted to sort after every migration already on main.
