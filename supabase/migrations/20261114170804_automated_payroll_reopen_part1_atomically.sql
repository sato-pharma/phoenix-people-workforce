-- automated_payroll_reopen_part1_atomically
--
-- WHAT THIS CHANGES: one new function, phx_reopen_automated_payroll_part1. Reopen Part 1 now does all of
--   its database writes in ONE transaction, under the reopen's claim:
--     1. every draft row of the run loses what confirming Part 1 stamped (the frozen first instalment,
--        settled-in-Part-1, withheld-in-Part-1, and the joiner / leaver basis: base, allowance, fuel,
--        days worked), written as "part1_reopened" by the person reopening, so the cell-history trigger
--        records each cleared cell under his name;
--     2. the run's held-salary reservations (automated_payroll_held_releases, paying_run_id = the run)
--        are withdrawn, with a held_release_recorded audit row when any were;
--     3. the run goes back to part1, its Part 1 confirmation cleared, and the claim let go.
--   Either all three land or none does.
-- WHY: payroll audit 2026-11-14, finding 3 (owner chose "All or nothing"). The app did these as three
--   separate calls: the freeze was erased first, then the reservations withdrawn, then the phase moved.
--   A failure after the first call left the run in Part 2 with no frozen first instalment, so every
--   person read as "joined after Part 1" and, once acknowledged, the second instalment became the whole
--   month. Never happened (October 2026 was read: its 8 unfrozen rows are all people not paid that month).
-- ROLLBACK: drop function public.phx_reopen_automated_payroll_part1(uuid, uuid, text);
--   (and ship the matching code revert — the app calls it from unconfirmPart1).
--
-- Add-only: no table, column or row changes on apply. Production has NO point-in-time recovery — 7 daily
-- backups are the whole recovery story.

begin;

create or replace function public.phx_reopen_automated_payroll_part1(
  p_run_id uuid,
  p_transition_token uuid,
  p_actor_hr_id text
)
returns setof public.automated_payroll_runs
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_run public.automated_payroll_runs%rowtype;
  v_withdrawn integer := 0;
begin
  -- The phase write first, conditioned on the claim this reopen holds and on the phase: a lost claim
  -- refuses before a single figure is touched.
  update public.automated_payroll_runs
     set phase = 'part1',
         part1_confirmed_at = null,
         part1_confirmed_by = null,
         updated_at = now(),
         transition_token = null,
         transition_action = null,
         transition_started_at = null
   where id = p_run_id
     and phase = 'part2'
     and transition_token = p_transition_token
  returning * into v_run;

  if not found then
    raise exception 'automated_payroll_transition_claim_lost: [transition-claim-lost] Part 1 was not reopened'
      using errcode = 'P0001';
  end if;

  update public.automated_payroll_draft_rows
     set first_part_frozen = null,
         settled_in_part1 = null,
         part1_withheld = null,
         base_for_month = null,
         ecol_paid = null,
         fuel_paid = null,
         days_worked = null,
         edited_by = p_actor_hr_id,
         write_reason = 'part1_reopened',
         write_step_key = null,
         updated_at = now()
   where run_id = p_run_id;

  delete from public.automated_payroll_held_releases
   where paying_run_id = p_run_id;
  get diagnostics v_withdrawn = row_count;

  if v_withdrawn > 0 then
    insert into public.automated_payroll_audit (run_id, actor_hr_id, action, step_key, detail)
    values (
      p_run_id,
      p_actor_hr_id,
      'held_release_recorded',
      null,
      jsonb_build_object('stage', 'part1_reopened', 'released', '[]'::jsonb, 'withdrawn', v_withdrawn)
    );
  end if;

  return next v_run;
end;
$$;

comment on function public.phx_reopen_automated_payroll_part1(uuid, uuid, text) is
  'Reopens Part 1 of an Automated Payroll run in one transaction under the reopen claim: clears what '
  'confirming Part 1 stamped on every draft row, withdraws the run''s held-salary reservations, and moves '
  'the run back to part1 (payroll audit 2026-11-14, finding 3).';

revoke execute on function public.phx_reopen_automated_payroll_part1(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.phx_reopen_automated_payroll_part1(uuid, uuid, text) to service_role;

commit;
