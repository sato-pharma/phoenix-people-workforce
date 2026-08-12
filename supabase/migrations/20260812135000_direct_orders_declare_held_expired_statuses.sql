-- Direct Orders — declare `held` and `expired` in the workflow registry (repair, 2026-08-12)
--
-- THE MISSING HALF OF 20260804210000_direct_orders_held_lane.sql.
--
-- That migration did three things: it extended `direct_order_requests_status_check` to permit
-- 'held' and 'expired', it added the `held_at` clock, and it appended three actions
-- (submit_held, revive_held, expire_held) that reference those statuses. What it never did was add
-- them to `workflow_registry_modules.statuses` — so the module has, since 2026-08-04, declared
-- actions pointing at statuses it does not declare.
--
-- WHY THAT IS SERIOUS RATHER THAN COSMETIC. normalizeActions() throws on an action whose `from` or
-- `to` names an undeclared status; listWorkflowRegistryModules() catches, logs, and SKIPS THE WHOLE
-- MODULE. Every direct_orders transition then refuses — reps cannot raise an order at all. That is
-- not hypothetical: it is the 2026-08-05 outage, and every direct-orders migration written since
-- carries a loader simulation specifically to prevent a repeat. Those simulations have been
-- failing-closed on a fault that was already present rather than one being introduced.
--
-- OBSERVED ON STAGING (cifwmndunmlxjhyjugxa) on 2026-08-12: 6 statuses declared, and
-- decide_pharmacy_validation, expire_held, request_pharmacy_validation, revive_held and
-- submit_held all naming 'held' or 'expired'. The repair-approval-rung migration's own loader
-- simulation refused to commit there and named all eight violations.
--
-- WHY THIS FILE STILL EXISTS NOW THAT held_lane ITSELF IS FIXED.
--
-- 20260804210000_direct_orders_held_lane.sql now declares both statuses in its own step 1b, which
-- is what makes the chain REPLAYABLE from scratch. That edit cannot help an environment which had
-- already applied that file: Supabase records migration history by VERSION, the version is
-- unchanged, and so it never runs there again.
--
-- So the two files cover disjoint populations and neither is redundant:
--
--   held_lane step 1b   -> every database created FROM NOW ON, at the point the statuses are first
--                          needed, before the actions that reference them are appended.
--   THIS FILE           -> every database that applied held_lane BEFORE that edit. Staging was
--                          exactly that: 6 statuses declared, five actions naming 'held' or
--                          'expired'. Production already had all nine, so this is a no-op there.
--
-- On a fresh replay this file runs and does nothing, because held_lane got there first. That is the
-- intended outcome, not a wasted migration — a repair that is a no-op on healthy databases is how
-- it stays safe to apply everywhere.
--
-- ADDITIVE AND IDEMPOTENT. It declares only the two statuses the TABLE has permitted since
-- 2026-08-04 and that four existing actions already reference. It widens nothing: a status in this
-- array is a name the loader will accept, not a permission, and every guard that decides who may
-- move an order remains exactly where it was. Where the statuses are already present — production
-- is expected to be, since actions added after them have been working — the `not exists` guard
-- makes this a no-op.

begin;

update public.workflow_registry_modules
set statuses = statuses || jsonb_build_array(
      jsonb_build_object(
        'key', 'held',
        'label', 'Customer Verification Required',
        'description', 'Submitted, but the pharmacy is not in the master database, so the order is in no approver''s queue. It moves when the pharmacy is verified, or expires after 14 days.'
      )
    ),
    updated_at = now()
where module_key = 'direct_orders'
  and not exists (
    select 1 from jsonb_array_elements(statuses) s where s->>'key' = 'held'
  );

update public.workflow_registry_modules
set statuses = statuses || jsonb_build_array(
      jsonb_build_object(
        'key', 'expired',
        'label', 'Expired',
        'description', 'The pharmacy was never verified, so the order timed out after 14 days without ever reaching an approver.'
      )
    ),
    updated_at = now()
where module_key = 'direct_orders'
  and not exists (
    select 1 from jsonb_array_elements(statuses) s where s->>'key' = 'expired'
  );

-- `version` is deliberately NOT set. workflow_registry_modules_touch is a BEFORE UPDATE trigger
-- that already bumps it; setting it explicitly is what moved the row 5 -> 7 instead of 5 -> 6 on
-- 2026-08-05.

-- Both must now be declared. Two separate `update ... where not exists` statements that each
-- matched nothing would be silent, and silence is how this fault survived eight days.
do $$
declare
  missing text;
begin
  select string_agg(want, ', ')
    into missing
  from unnest(array['held', 'expired']) as want
  where not exists (
    select 1
    from public.workflow_registry_modules m,
         jsonb_array_elements(m.statuses) s
    where m.module_key = 'direct_orders'
      and s->>'key' = want
  );

  if missing is not null then
    raise exception 'statuses still undeclared after the repair: %', missing;
  end if;
end $$;

-- The loader simulation, run over the WHOLE module. This is the check the module exists to satisfy,
-- and the first time it should pass on an environment that carries the held lane.
do $$
declare
  bad text;
begin
  select string_agg(distinct problem, ', ')
    into bad
  from (
    select format('action %s -> undeclared target %L', a->>'key', a->>'to') as problem
    from public.workflow_registry_modules m,
         jsonb_array_elements(m.actions) a
    where m.module_key = 'direct_orders'
      and not exists (
        select 1 from jsonb_array_elements(m.statuses) s where s->>'key' = a->>'to'
      )
    union all
    select format('action %s <- undeclared source %L', a->>'key', f.value)
    from public.workflow_registry_modules m,
         jsonb_array_elements(m.actions) a,
         jsonb_array_elements_text(a->'from') f(value)
    where m.module_key = 'direct_orders'
      and not exists (
        select 1 from jsonb_array_elements(m.statuses) s where s->>'key' = f.value
      )
  ) problems;

  if bad is not null then
    raise exception 'direct_orders registry would STILL be SKIPPED by the loader: %', bad;
  end if;
end $$;

commit;
