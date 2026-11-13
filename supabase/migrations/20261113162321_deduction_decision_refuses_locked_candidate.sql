-- deduction_decision_refuses_locked_candidate
--
-- WHAT THIS CHANGES:
--   A BEFORE INSERT OR UPDATE trigger on public.deductions_decisions,
--   phx_deductions_decisions_refuse_locked, that reads the candidate's locked_at under a FOR SHARE row
--   lock and refuses a decision whose deciding fields change while the candidate is locked by a
--   publication. The one exemption is recovery.restore_table putting the whole table back to an
--   earlier version (it takes a pre-image of deductions_decisions in the same transaction first).
--
-- WHY (enterprise audit 2026-11-13, finding F-PAY-004):
--   recordDecision (src/lib/deductions/service.ts) read locked_at, refused a locked candidate, read the
--   existing decision, then upserted — three separate statements with no condition on the write. A
--   push or publication that locked the candidate between the read and the upsert let the decision
--   overwrite a figure that had just been frozen onto the employee's payslip line. The FOR SHARE lock
--   here serializes the decision against the lock: a publication that locked first is seen and the
--   decision refused; a decision that got the row first finishes before the publication can lock it.
--
--   Every writer of deductions_decisions was read before this was written (2026-11-13):
--     * src/lib/deductions/service.ts recordDecision (upsert) — already refuses a locked candidate in
--       application code; this closes its race. Every route reaches decisions through it: the
--       deductions workspace, leave-balance.ts, digest-bridge.ts, employee-day-report.ts,
--       digest-money.ts and the Dispute Center's decideDeductionDispute.
--     * service.ts collection insert (paired decision rows for candidates inserted a moment earlier
--       in the same pass) — a new candidate is never locked.
--     * service.ts carry-forward update onto a replacement candidate — the replacement is a row the
--       same re-collect just inserted (never locked), and a locked candidate is skipped before it.
--     * public.phx_restore_deduction_dispute_state (20261113162318) — takes the lock off first,
--       writes the decision back, then restores the lock.
--     * recovery.restore_table — whole-table restore by the owner; exempted below.
--     No SQL function or trigger in supabase/migrations inserts or updates deductions_decisions besides
--     these; publish and push only read it.
--
-- ROLLBACK:
--   drop trigger if exists phx_deductions_decisions_refuse_locked on public.deductions_decisions;
--   drop function if exists public.phx_deductions_decisions_refuse_locked();
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- Nothing here writes data: one trigger function and one trigger.

begin;

create or replace function public.phx_deductions_decisions_refuse_locked()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_locked_at timestamptz;
begin
  -- Only a change to what the decision charges or says is refused; a write that leaves every
  -- deciding field as it was moves no money.
  if tg_op = 'UPDATE'
     and (new.candidate_id, new.decision_status, new.decision_reason, new.hr_note, new.applied_value,
          new.applied_amount, new.applied_dates, new.decided_by)
         is not distinct from
         (old.candidate_id, old.decision_status, old.decision_reason, old.hr_note, old.applied_value,
          old.applied_amount, old.applied_dates, old.decided_by) then
    return new;
  end if;

  select c.locked_at into v_locked_at
  from public.deductions_candidates c
  where c.id = new.candidate_id
  for share;

  if v_locked_at is null then
    return new;
  end if;

  -- recovery.restore_table deletes and re-inserts the whole table after taking its pre-image in the
  -- SAME transaction (taken_at is clock_timestamp(), so it is at or after this transaction's now()).
  if to_regclass('recovery.restore_preimages') is not null
     and exists (
       select 1 from recovery.restore_preimages rp
       where rp.source_schema = 'public'
         and rp.source_table = 'deductions_decisions'
         and rp.taken_at >= now()
     ) then
    return new;
  end if;

  raise exception
    'deductions_decisions: candidate % is locked by a publication (locked_at=%) — withdraw its line before deciding it again',
    new.candidate_id, v_locked_at
    using errcode = '55000';
end;
$$;

comment on function public.phx_deductions_decisions_refuse_locked() is
  'BEFORE INSERT OR UPDATE ROW trigger on public.deductions_decisions (F-PAY-004): refuses a decision '
  'change on a candidate a publication has locked, under a FOR SHARE lock of the candidate row. '
  'Exempt: recovery.restore_table in the same transaction.';

revoke execute on function public.phx_deductions_decisions_refuse_locked() from public, anon, authenticated;
grant execute on function public.phx_deductions_decisions_refuse_locked() to service_role;

drop trigger if exists phx_deductions_decisions_refuse_locked on public.deductions_decisions;
create trigger phx_deductions_decisions_refuse_locked
  before insert or update on public.deductions_decisions
  for each row execute function public.phx_deductions_decisions_refuse_locked();

commit;
