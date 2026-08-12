-- Direct Orders — repair_approval_rung (task #90 / Priority 7, 2026-08-12)
--
-- THE FAILURE THIS EXISTS FOR. `buildApprovalChain` climbs `manager_hr_id` from the requester
-- upward. When a link points at an HR_ID the employee directory does not carry — a departed record,
-- a mistyped one — the rung is still created and bound to that raw HR_ID. NOBODY can ever act on it:
-- no session resolves to an HR_ID that is not in the directory. The order sits at `pending_approval`
-- forever, and the only visible symptom is a requester eventually asking why nothing has happened.
--
-- fe60edc0 made the break VISIBLE: the rung is labelled "Unresolved manager (<hr_id>)" and a
-- `direct_order_chain_unresolved_manager` line is logged. That was half the job. A flag nobody can
-- act on is a better-documented dead end, not a way out. This action is the way out.
--
-- WHAT IT DOES, AND DELIBERATELY DOES NOT DO:
--
--   DOES     rebind ONE pending rung from an unresolvable HR_ID to a real, active person, with a
--            recorded reason and an audit line naming who did it.
--   DOES NOT approve, reject, skip or remove the rung. The order stays exactly where it is, at
--            `pending_approval`, still owing the same number of approvals to the same seats. The
--            person who was going to have to say yes still has to say yes — they are simply
--            somebody who exists.
--
-- Hence 'from' and 'to' are BOTH `pending_approval`. This is the `keep_held` precedent: an action
-- whose point is the recorded decision rather than a status move is still an action, and is still
-- declared here, because the registry is how this module answers "who may do what, when".
--
-- SUPER ADMIN ONLY. The service refuses everyone else. Widening it would turn a directory repair
-- into a way to choose one's own approver, which is the approval chain itself — and the standing
-- rule is that consolidation and repair work must never widen access. The service ALSO refuses to
-- touch a rung whose approver resolves perfectly well, so this cannot be used to move a healthy
-- approval off someone inconvenient. That guard is the difference between a repair and an override.
--
-- NO NEW STATUSES. Both endpoints are already declared. The 2026-08-05 outage — every direct_orders
-- transition dead, reps unable to raise an order at all — happened because an action referenced an
-- UNDECLARED status: normalizeActions() throws, listWorkflowRegistryModules() catches, logs, and
-- SKIPS the whole module. The loader simulation at the end of this file therefore runs again here;
-- the guarantee is enforced rather than trusted.
--
-- DEPLOYMENT COUPLING, STATED PLAINLY: until this row exists,
-- `assertDirectOrderWorkflowTransition` throws for this key and the repair refuses. The desk will
-- render, list the stuck orders correctly, and fail on the repair button. That is the safe
-- direction — the alternative is a repair that bypasses the governance layer — but it means this
-- file must be applied before the feature is announced to anyone.

begin;

update public.workflow_registry_modules
set actions = actions || jsonb_build_array(
      jsonb_build_object(
        'key', 'repair_approval_rung',
        'label', 'Re-addressed a stuck approval rung to a person who exists — the directory record it pointed at is gone',
        'from', jsonb_build_array('pending_approval'),
        'to', 'pending_approval',
        'auditLog', 'Direct order approval rung re-addressed from an unresolvable HR_ID to an active approver',
        'requiresReason', true,
        'sideEffects', jsonb_build_array('rebind one pending step approver_hr_id', 'relabel that step'),
        'notifications', jsonb_build_array('notify the new approver + the requester'),
        'tests', jsonb_build_array(
          'a HEALTHY rung is refused — this is a repair, not a way to pick your approver',
          'the requester cannot be made their own approver',
          'the request status is unchanged and no rung is added or removed'
        ),
        'allowedRoles', jsonb_build_array('Super Admin')
      )
    ),
    updated_at = now()
where module_key = 'direct_orders'
  and not exists (
    select 1 from jsonb_array_elements(actions) a where a->>'key' = 'repair_approval_rung'
  );

-- `version` is deliberately NOT set. workflow_registry_modules_touch is a BEFORE UPDATE trigger that
-- already bumps it; setting it explicitly is what moved the row 5 -> 7 instead of 5 -> 6 on
-- 2026-08-05.

-- Simulate the loader before committing — the check whose absence cost the outage. If any action
-- references a status the module does not declare, the whole module is skipped at runtime and the
-- failure surfaces only as a log line. Failing here rolls the transaction back instead.
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
    union all
    select format('action %s is missing a required %L', a->>'key', field)
    from public.workflow_registry_modules m,
         jsonb_array_elements(m.actions) a,
         unnest(array['key', 'label', 'to', 'auditLog']) as field
    where m.module_key = 'direct_orders'
      and coalesce(nullif(trim(a->>field), ''), null) is null
  ) problems;

  if bad is not null then
    raise exception 'direct_orders registry would be SKIPPED by the loader: %', bad;
  end if;
end $$;

-- The row must actually be there. An `update ... where not exists` that matched nothing is silent,
-- and a silently-absent action is exactly the shape of the bug this module keeps re-learning.
do $$
begin
  if not exists (
    select 1
    from public.workflow_registry_modules m,
         jsonb_array_elements(m.actions) a
    where m.module_key = 'direct_orders'
      and a->>'key' = 'repair_approval_rung'
  ) then
    raise exception 'repair_approval_rung was not added — the direct_orders registry row is missing or was not matched';
  end if;
end $$;

commit;
