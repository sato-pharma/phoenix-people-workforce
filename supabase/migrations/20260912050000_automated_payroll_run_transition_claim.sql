-- ---------------------------------------------------------------------------
-- One transition at a time on an Automated Payroll run (audit finding 50).
--
-- Every phase change read the run, checked its phase in application code, did seconds of work, then
-- wrote the new phase with no condition and no transaction. Two overlapping requests both passed the
-- check and the later writer won. A cancel landing while Part 2 confirm was still running was
-- overwritten back to 'ready' (publishable again) with carry-forward balances recorded against a run
-- someone had cancelled; a cancel racing publish could write 'cancelled' over 'published' and un-mark
-- the debts publish had just recovered.
--
-- A transition now CLAIMS the run before its first write, in one statement that also re-checks the
-- phase. A second transition, or a step save, meets the claim and is refused before it writes
-- anything. The phase write is conditioned on the claim and clears it. A claim left by a request that
-- died lapses after 15 minutes; src/lib/automated-payroll/transition-claim.ts carries the same figure,
-- and a test holds the two together.
--
-- Add-only: three nullable columns and one function. Every existing run reads as unclaimed.
-- ---------------------------------------------------------------------------

alter table public.automated_payroll_runs
  add column if not exists transition_token uuid,
  add column if not exists transition_action text,
  add column if not exists transition_started_at timestamptz;

comment on column public.automated_payroll_runs.transition_token is
  'Held while a phase transition is writing. Null when no transition holds the run.';
comment on column public.automated_payroll_runs.transition_action is
  'What the claiming transition is doing, in words, for the refusal a second request sees.';
comment on column public.automated_payroll_runs.transition_started_at is
  'When the claim was taken. A claim older than 15 minutes has lapsed and may be taken over.';

create or replace function public.phx_claim_automated_payroll_run_transition(
  p_run_id uuid,
  p_expected_phases text[],
  p_action text
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_token uuid := gen_random_uuid();
begin
  update public.automated_payroll_runs
     set transition_token = v_token,
         transition_action = p_action,
         transition_started_at = now()
   where id = p_run_id
     and phase = any (p_expected_phases)
     and (transition_token is null or transition_started_at < now() - interval '15 minutes');
  if not found then
    return null;
  end if;
  return v_token;
end;
$$;

comment on function public.phx_claim_automated_payroll_run_transition(uuid, text[], text) is
  'Claims an Automated Payroll run for one phase transition. Returns the claim token, or null when the '
  'run is not in an expected phase or another live transition already holds it.';

revoke execute on function public.phx_claim_automated_payroll_run_transition(uuid, text[], text) from public, anon, authenticated;
grant execute on function public.phx_claim_automated_payroll_run_transition(uuid, text[], text) to service_role;
