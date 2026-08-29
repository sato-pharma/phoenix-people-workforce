-- Recruitment — retire the offer_initiated -> hired shortcut. Its reason expired on 2026-08-21.
--
-- WHY IT IS THERE. 20260724130000_ats_replatform_phase1.sql added it deliberately, and said so:
--
--     "app_hire currently only allows from [offer_accepted, pre_boarding]. offer_accepted is now
--      unreachable (the whole offer pipeline that produced it is gone); add offer_initiated (the
--      new direct-hire waypoint reached via app_select) so markApplicationHired can actually fire."
--
-- That was correct at the time. The replatform dropped public.job_offers, so nothing could ever
-- reach offer_accepted, and without this entry the hire action was dead. offer_initiated became
-- the direct-hire waypoint because there was no offer to wait for.
--
-- WHY IT NO LONGER IS. 20260821160000_ats_offers.sql restored the terms table and with it the whole
-- twelve-step chain, which is live and complete in the registry today:
--
--     final_selection -> offer_initiated -> offer_draft -> offer_pending_approval -> offer_approved
--     -> offer_generated -> offer_sent -> offer_accepted -> hired
--
-- offer_accepted is reachable again, so the premise of the July entry is gone. What is left is a
-- shortcut from the FIRST stage of the offer chain straight to hired -- skipping preparation,
-- Super Admin approval, generation, sending, and the candidate's own answer. offer_initiated means
-- "an offer was drafted", nothing more.
--
-- THIS IS THE SECOND SHORTCUT OF THIS SHAPE, and the first one is the precedent for handling it.
-- The same interim left app_offer_sent reachable from offer_initiated, skipping approval. That one
-- was closed in CODE -- markOfferSent refuses while approved_at is null (see the comment on
-- ats_offers.approved_at, and src/lib/recruitment/offer-rules.ts) -- and it is still open in the
-- registry to this day. The hire shortcut is now closed in code too, by
-- src/lib/recruitment/hire-offer-guard.ts (#2681), which refuses a hire with no accepted offer
-- before anything is written. THAT is the enforcement; this migration is not.
--
-- WHAT THIS MIGRATION IS FOR, THEN. The registry is runtime-editable configuration, so nothing here
-- can be a security boundary -- the next edit could put the entry back and no test would fail.
-- It is the DOCUMENTED workflow, and it currently documents a path the product does not support.
-- Leaving it says "you may hire from offer_initiated" to every reader and to the admin UI that
-- renders the action. This closes the gap between what the registry claims and what the code does.
--
-- SAFE. Production holds 14 applications, none past hr_interview, zero offers and zero hires, so no
-- application is at offer_initiated and none has ever used this transition. offer_accepted and
-- pre_boarding are untouched, and nothing in src/, app/ or tests/ ties offer_initiated to hiring --
-- the one test that matches the string pins the July migration's own text, which is not edited here.

begin;

update public.workflow_registry_modules
set actions = (
  select jsonb_agg(
    case
      when action ->> 'key' = 'app_hire'
        then jsonb_set(
          action,
          '{from}',
          -- Keep the order stable and drop only offer_initiated. jsonb_agg over a filtered
          -- element list rather than a rebuilt literal, so any other stage that has been added
          -- to this action since is preserved rather than silently reverted.
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
    updated_by = 'migration:20260829233000',
    updated_at = now()
where module_key = 'recruitment'
  and exists (
    select 1
    from jsonb_array_elements(actions) as action
    where action ->> 'key' = 'app_hire'
      and action -> 'from' ? 'offer_initiated'
  );

-- Fail the migration rather than report success on a no-op that silently did nothing.
do $$
declare
  v_from jsonb;
begin
  select action -> 'from'
    into v_from
  from public.workflow_registry_modules m,
       lateral jsonb_array_elements(m.actions) as action
  where m.module_key = 'recruitment'
    and action ->> 'key' = 'app_hire';

  if v_from is null then
    raise exception 'app_hire action not found on the recruitment module';
  end if;

  if v_from ? 'offer_initiated' then
    raise exception 'app_hire still allows offer_initiated: %', v_from;
  end if;

  if not (v_from ? 'offer_accepted') then
    raise exception 'app_hire lost offer_accepted, which is the only correct source stage: %', v_from;
  end if;

  raise notice 'app_hire now allows: %', v_from;
end;
$$;

commit;

notify pgrst, 'reload schema';
