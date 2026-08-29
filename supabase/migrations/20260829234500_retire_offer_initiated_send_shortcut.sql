-- Recruitment — retire the second offer_initiated shortcut: offer_initiated -> offer_sent.
--
-- The sibling of 20260829233000_retire_offer_initiated_hire_shortcut.sql, and the last one of this
-- shape in the recruitment module.
--
-- WHAT IT IS. app_offer_sent is reachable from offer_initiated as well as offer_generated. The
-- correct route to offer_sent is the whole chain:
--
--     offer_initiated -> offer_draft -> offer_pending_approval -> offer_approved
--                     -> offer_generated -> offer_sent
--
-- app_offer_generated allows only offer_approved, so offer_generated is the single legitimate
-- source stage. Sending from offer_initiated skips preparation of the terms, submission, the Super
-- Admin approval and generation -- an offer reaching a candidate having never been approved, and
-- carrying no agreed figures at all, because offer_initiated is the stage BEFORE the terms exist.
--
-- THIS IS NOT WHAT STOPS IT, AND NEVER WAS. The owner's rule is one approval before sending, and it
-- is enforced in code: offerSendBlockReason (src/lib/recruitment/offer-rules.ts) refuses while
-- approvedAt is null, and markOfferSent calls it (src/lib/recruitment/offers.ts:316) before any
-- write. That guard reads the approval TRAIL rather than the stage precisely so this registry entry
-- cannot matter, and tests/recruitment-offers.test.ts pins it as its headline assertion. None of
-- that changes here, and none of it should: the registry is runtime-editable configuration, so it
-- can never be the boundary -- the next edit could put this entry back and no test would fail.
--
-- WHAT THIS IS FOR. The registry is also the DOCUMENTED workflow, read by people and rendered by
-- the admin UI, and it currently advertises a transition the product refuses. A reader comparing
-- the registry against the code finds a contradiction and has to work out which one is lying. That
-- is the whole defect being fixed: after this, the two agree, and the code guard becomes a
-- belt-and-braces second lock rather than the only thing standing between a draft and a candidate.
--
-- SAFE. Production holds 14 applications, none past hr_interview, zero offers and zero hires, so no
-- application is at offer_initiated and this transition has never been used. offer_generated is
-- untouched. No test asserts that the registry contains this entry -- tests/recruitment-offers.test.ts
-- asserts the CODE guard's behaviour and only mentions the entry in a comment, corrected alongside
-- this migration.

begin;

update public.workflow_registry_modules
set actions = (
  select jsonb_agg(
    case
      when action ->> 'key' = 'app_offer_sent'
        then jsonb_set(
          action,
          '{from}',
          -- Filter rather than rebuild from a literal, so any stage added to this action since
          -- is preserved instead of being silently reverted to a hard-coded pair.
          coalesce(
            (
              select jsonb_agg(v)
              from jsonb_array_elements_text(action -> 'from') as v
              where v <> 'offer_initiated'
            ),
            '[]'::jsonb
          )
        )
      else action
    end
    order by ord
  )
  from jsonb_array_elements(actions) with ordinality as t(action, ord)
),
    version = version + 1,
    updated_by = 'migration:20260829234500',
    updated_at = now()
where module_key = 'recruitment'
  and exists (
    select 1
    from jsonb_array_elements(actions) as action
    where action ->> 'key' = 'app_offer_sent'
      and action -> 'from' ? 'offer_initiated'
  );

-- Fail rather than report success on a no-op that silently did nothing.
do $$
declare
  v_sent jsonb;
  v_hire jsonb;
begin
  select action -> 'from' into v_sent
  from public.workflow_registry_modules m, lateral jsonb_array_elements(m.actions) as action
  where m.module_key = 'recruitment' and action ->> 'key' = 'app_offer_sent';

  select action -> 'from' into v_hire
  from public.workflow_registry_modules m, lateral jsonb_array_elements(m.actions) as action
  where m.module_key = 'recruitment' and action ->> 'key' = 'app_hire';

  if v_sent is null then
    raise exception 'app_offer_sent action not found on the recruitment module';
  end if;

  if v_sent ? 'offer_initiated' then
    raise exception 'app_offer_sent still allows offer_initiated: %', v_sent;
  end if;

  if not (v_sent ? 'offer_generated') then
    raise exception 'app_offer_sent lost offer_generated, its only correct source stage: %', v_sent;
  end if;

  -- The sibling migration must still hold; both shortcuts are closed or neither is worth claiming.
  if v_hire ? 'offer_initiated' then
    raise exception 'app_hire allows offer_initiated again — 20260829233000 has been reverted: %', v_hire;
  end if;

  raise notice 'app_offer_sent now allows: %, app_hire allows: %', v_sent, v_hire;
end;
$$;

commit;

notify pgrst, 'reload schema';
