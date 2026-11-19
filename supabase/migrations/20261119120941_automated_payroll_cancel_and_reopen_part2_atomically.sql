-- automated_payroll_cancel_and_reopen_part2_atomically
--
-- WHAT THIS CHANGES: two new functions. Cancelling an Automated Payroll run and reopening its Part 2 now
--   each do ALL of their database writes in ONE transaction, under the claim the move holds:
--     phx_cancel_automated_payroll_run        — the run goes to cancelled;
--     phx_reopen_automated_payroll_part2      — the run goes back to part2, its Part 2 confirmation cleared;
--   and in both, in the same transaction:
--     1. when finance had downloaded the run's files and the person gave a reason to go ahead anyway, the
--        undo_after_download_overridden audit row (who, why, which files, which move) — p_override_detail;
--     2. the late-approved trips the run had set aside (automated_payroll_carried_expenses) are released;
--     3. the carry-forward balances the run had marked recovered are released, and the balances the run
--        itself created and nobody recovered are discarded (automated_payroll_carry_forward);
--     4. the run_cancelled / part2_unconfirmed audit row with what 2 and 3 did;
--     5. the claim is let go.
--   Either every one of these lands or none does. Each refuses before writing anything when the claim is
--   no longer this move's (automated_payroll_transition_claim_lost), as phx_reopen_automated_payroll_part1 does.
-- WHY: REC-038 close-out, 19 Nov 2026. The app did these as four or five separate calls — the override
--   record, the trips, the ledger release, the ledger discard, then the phase — so a failure after the
--   first left a run still `ready` (or still in Part 2) with its reserved trips back on the list, or its
--   ledger half released, or an override recorded for a cancel that never happened. Reopen Part 1 was
--   made one call on 14 Nov 2026 (20261114170804); these are the other two moves that undo a confirmed
--   run. Nothing in the money changes: the same rows are written, in the same order, only together.
-- ROLLBACK: drop function public.phx_cancel_automated_payroll_run(uuid, uuid, text, jsonb);
--           drop function public.phx_reopen_automated_payroll_part2(uuid, uuid, text, jsonb);
--   (and ship the matching code revert — the app calls them from cancelRun and unconfirmPart2).
--
-- Add-only: no table, column or row changes on apply, and the code live before this PR keeps working
-- (it does not call these). The code in this PR needs both applied first: without them Cancel run and
-- Reopen Part 2 refuse and change nothing.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create or replace function public.phx_cancel_automated_payroll_run(
  p_run_id uuid,
  p_transition_token uuid,
  p_actor_hr_id text,
  p_override_detail jsonb default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_run public.automated_payroll_runs%rowtype;
  v_released integer := 0;
  v_discarded integer := 0;
  v_detail jsonb;
begin
  -- The phase write first, conditioned on the claim this cancel holds and on the run still being open: a
  -- lost claim refuses before a single row is touched.
  update public.automated_payroll_runs
     set phase = 'cancelled',
         updated_at = now(),
         transition_token = null,
         transition_action = null,
         transition_started_at = null
   where id = p_run_id
     and phase in ('part1', 'part2', 'ready')
     and transition_token = p_transition_token
  returning * into v_run;

  if not found then
    raise exception 'automated_payroll_transition_claim_lost: [transition-claim-lost] the run was not cancelled'
      using errcode = 'P0001';
  end if;

  if p_override_detail is not null then
    insert into public.automated_payroll_audit (run_id, actor_hr_id, action, step_key, detail)
    values (p_run_id, p_actor_hr_id, 'undo_after_download_overridden', null, p_override_detail);
  end if;

  delete from public.automated_payroll_carried_expenses
   where run_id = p_run_id;

  update public.automated_payroll_carry_forward
     set applied_run_id = null,
         applied_at = null,
         updated_at = now()
   where applied_run_id = p_run_id;
  get diagnostics v_released = row_count;

  delete from public.automated_payroll_carry_forward
   where source_run_id = p_run_id
     and applied_run_id is null;
  get diagnostics v_discarded = row_count;

  v_detail := jsonb_build_object('carryForwardReleased', v_released, 'carryForwardDiscarded', v_discarded);
  if p_override_detail is not null then
    v_detail := v_detail || jsonb_build_object(
      'cancelledAfterBankFileDownload', true,
      'overrideReason', p_override_detail ->> 'reason'
    );
  end if;
  insert into public.automated_payroll_audit (run_id, actor_hr_id, action, step_key, detail)
  values (p_run_id, p_actor_hr_id, 'run_cancelled', null, v_detail);

  return jsonb_build_object('run', to_jsonb(v_run), 'released', v_released, 'discarded', v_discarded);
end;
$$;

comment on function public.phx_cancel_automated_payroll_run(uuid, uuid, text, jsonb) is
  'Cancels an Automated Payroll run in one transaction under the cancel claim: the override record when one '
  'was given, the run''s reserved late trips and carry-forward ledger released, the run_cancelled audit row, '
  'and the phase (REC-038, 19 Nov 2026).';

revoke execute on function public.phx_cancel_automated_payroll_run(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.phx_cancel_automated_payroll_run(uuid, uuid, text, jsonb) to service_role;

create or replace function public.phx_reopen_automated_payroll_part2(
  p_run_id uuid,
  p_transition_token uuid,
  p_actor_hr_id text,
  p_override_detail jsonb default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_run public.automated_payroll_runs%rowtype;
  v_released integer := 0;
  v_discarded integer := 0;
  v_detail jsonb;
begin
  update public.automated_payroll_runs
     set phase = 'part2',
         part2_confirmed_at = null,
         part2_confirmed_by = null,
         updated_at = now(),
         transition_token = null,
         transition_action = null,
         transition_started_at = null
   where id = p_run_id
     and phase = 'ready'
     and transition_token = p_transition_token
  returning * into v_run;

  if not found then
    raise exception 'automated_payroll_transition_claim_lost: [transition-claim-lost] Part 2 was not reopened'
      using errcode = 'P0001';
  end if;

  if p_override_detail is not null then
    insert into public.automated_payroll_audit (run_id, actor_hr_id, action, step_key, detail)
    values (p_run_id, p_actor_hr_id, 'undo_after_download_overridden', null, p_override_detail);
  end if;

  delete from public.automated_payroll_carried_expenses
   where run_id = p_run_id;

  update public.automated_payroll_carry_forward
     set applied_run_id = null,
         applied_at = null,
         updated_at = now()
   where applied_run_id = p_run_id;
  get diagnostics v_released = row_count;

  delete from public.automated_payroll_carry_forward
   where source_run_id = p_run_id
     and applied_run_id is null;
  get diagnostics v_discarded = row_count;

  v_detail := jsonb_build_object('carryForwardReleased', v_released, 'carryForwardDiscarded', v_discarded);
  if p_override_detail is not null then
    v_detail := v_detail || jsonb_build_object(
      'reopenedAfterBankFileDownload', true,
      'overrideReason', p_override_detail ->> 'reason'
    );
  end if;
  insert into public.automated_payroll_audit (run_id, actor_hr_id, action, step_key, detail)
  values (p_run_id, p_actor_hr_id, 'part2_unconfirmed', null, v_detail);

  return jsonb_build_object('run', to_jsonb(v_run), 'released', v_released, 'discarded', v_discarded);
end;
$$;

comment on function public.phx_reopen_automated_payroll_part2(uuid, uuid, text, jsonb) is
  'Reopens Part 2 of an Automated Payroll run in one transaction under the reopen claim: the override record '
  'when one was given, the run''s reserved late trips and carry-forward ledger released, the part2_unconfirmed '
  'audit row, and the phase back to part2 (REC-038, 19 Nov 2026).';

revoke execute on function public.phx_reopen_automated_payroll_part2(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.phx_reopen_automated_payroll_part2(uuid, uuid, text, jsonb) to service_role;

commit;
