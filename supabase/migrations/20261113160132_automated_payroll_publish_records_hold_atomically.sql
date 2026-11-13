-- automated_payroll_publish_records_hold_atomically
--
-- WHAT THIS CHANGES: one function, phx_mark_automated_payroll_run_published. It marks a run published
--   AND writes its `published` audit row — the record of who was held that month and for how much — in
--   one statement's transaction. Either both land or neither does.
-- WHY: enterprise audit 2026-11-13, F-PAY-002 / REC-047. Who is still owed held salary is rebuilt from
--   that audit row, and it was written best-effort AFTER the run had already been marked published: a
--   failed insert left a published month with no held record, and its held people silently dropped out
--   of every later Held Salary Release. Now a run cannot reach `published` without the record, and the
--   function refuses a detail whose `held` list is missing.
-- ROLLBACK: drop function public.phx_mark_automated_payroll_run_published(uuid, uuid, uuid, text, text, jsonb);
--   (and ship the matching code revert — the app calls it at publish).
--
-- Add-only: no table, column or row changes. Production has NO point-in-time recovery — 7 daily
-- backups are the whole recovery story.

begin;

create or replace function public.phx_mark_automated_payroll_run_published(
  p_run_id uuid,
  p_transition_token uuid,
  p_batch_id uuid,
  p_published_by text,
  p_actor_hr_id text,
  p_detail jsonb
)
returns setof public.automated_payroll_runs
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_run public.automated_payroll_runs%rowtype;
begin
  -- The held list is the money record. A publish that cannot say who it held does not publish.
  if p_detail is null or jsonb_typeof(p_detail -> 'held') is distinct from 'array' then
    raise exception 'automated_payroll_publish_hold_record_missing: the publish record has no held list'
      using errcode = 'P0001';
  end if;

  -- Conditioned on the claim this publish holds (phx_claim_automated_payroll_run_transition) and on the
  -- phase, and clears the claim — the same rule as the app's conditioned phase write.
  update public.automated_payroll_runs
     set phase = 'published',
         published_batch_id = p_batch_id,
         published_at = now(),
         published_by = p_published_by,
         updated_at = now(),
         transition_token = null,
         transition_action = null,
         transition_started_at = null
   where id = p_run_id
     and phase = 'ready'
     and transition_token = p_transition_token
  returning * into v_run;

  if not found then
    raise exception 'automated_payroll_transition_claim_lost: [transition-claim-lost] the run was not marked published'
      using errcode = 'P0001';
  end if;

  insert into public.automated_payroll_audit (run_id, actor_hr_id, action, step_key, detail)
  values (p_run_id, p_actor_hr_id, 'published', null, p_detail);

  return next v_run;
end;
$$;

comment on function public.phx_mark_automated_payroll_run_published(uuid, uuid, uuid, text, text, jsonb) is
  'Marks an Automated Payroll run published and writes its published audit row (the held-salary record) '
  'in one transaction, under the publish claim. Refuses a detail with no held list (F-PAY-002).';

revoke execute on function public.phx_mark_automated_payroll_run_published(uuid, uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.phx_mark_automated_payroll_run_published(uuid, uuid, uuid, text, text, jsonb) to service_role;

commit;
