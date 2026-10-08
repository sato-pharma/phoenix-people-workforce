-- Direct Orders — close_orphaned (2026-10-08)
--
-- THE FAILURE THIS EXISTS FOR. `returned` is answerable by exactly one person. `reviseDirectOrder`
-- refuses anyone whose canonical HR_ID is not the requester's, because a return is a question
-- addressed to the person who raised the order. When that person resigns their login is disabled and
-- the question can never be answered. The order is not terminal, so nothing expires it; it is in
-- nobody's queue, so nothing chases it. It simply ages out of sight for ever.
--
-- `src/lib/approvals/orphaned-requests.ts` already FINDS these and the Needs You board already shows
-- the count. What did not exist was any way to clear one: `cancel_held` takes `held` only, and the
-- Stuck Approvals screen reassigns weekly plans and excuses and nothing else. So the board named a
-- remedy — "reassign or close them on the Direct Orders screen" — that the product could not
-- perform, and on 2026-10-08 five stranded orders (66,475.20 EGP, 52-56 days old, requesters B-23
-- and PD-0010, both resigned District Sales Managers on Pedia) were closed by hand-written SQL
-- against production. Pre-image: au.bak_20261008_orphaned_direct_orders. This action is the way out.
--
-- WHAT IT DOES, AND DELIBERATELY DOES NOT DO:
--
--   DOES     close ONE returned order whose requester the employee master reports as no longer
--            active, with a recorded reason and an audit line naming who did it.
--   DOES NOT reassign it to anybody. Reassigning looks kinder and is not: a resubmit reprices the
--            basket on TODAY's basis and resumes at the lowest still-pending rung — the CEO's own
--            rung, on four of those five — so it hands a live manager a money edit rather than an
--            administrative tidy. If the volume is still wanted it is raised fresh, by whoever holds
--            that territory now, at the discount the approver asked for.
--   DOES NOT touch the approval steps. An approver can only act on a `pending_approval` request, so
--            the untouched `pending` rungs reach nobody, and the record of who approved what — and
--            who returned it, in whose words — stays readable.
--   DOES NOT write a sales month, ever. Finance owns the month (standing owner rule).
--   DOES NOT expire anything. `listReturnedDirectOrdersAgeing` refuses to add an expiry on purpose:
--            killing an order the rep may never have seen would destroy real work to tidy a queue.
--
-- 'to' IS `cancelled`, NEVER `rejected`. No approver turned these down — four of the five were in
-- fact APPROVED by the SFE Manager and the National Sales Manager, and only the requester's step was
-- dead. Merging the two would inflate every rejection rate and per-status counter that groups by
-- status, which is the same reason `cancel_held` and `cancel_duplicate` are separate from `reject`.
--
-- SUPER ADMIN ONLY, and the service additionally REFUSES while the requester can still log in. That
-- second guard is the difference between clearing a dead end and a delete button: whoever is still
-- employed owns their own return. `repair_approval_rung` set the precedent — repair work must never
-- widen access — and a terminal decision on somebody else's sales request is further from a repair
-- than a rung rebind was, so it does not get a wider gate.
--
-- NO NEW STATUSES. `returned` and `cancelled` are both already declared. The 2026-08-05 outage —
-- every direct_orders transition dead, reps unable to raise an order at all — happened because an
-- action referenced an UNDECLARED status: normalizeActions() throws, listWorkflowRegistryModules()
-- catches, logs, and SKIPS the whole module. The loader simulation at the end of this file therefore
-- runs again here; the guarantee is enforced rather than trusted.
--
-- DEPLOYMENT COUPLING, STATED PLAINLY: until this row exists,
-- `assertDirectOrderWorkflowTransition` throws for this key and the close refuses. The panel will
-- render and list the stranded orders correctly, and fail on the button. That is the safe direction
-- — the alternative is a terminal write that bypasses the governance layer — but it means this file
-- must be applied before the feature is announced to anyone.

begin;

update public.workflow_registry_modules
set actions = actions || jsonb_build_array(
      jsonb_build_object(
        'key', 'close_orphaned',
        'label', 'Closed a returned order whose requester has left the company — nobody could ever answer the return',
        'from', jsonb_build_array('returned'),
        'to', 'cancelled',
        'auditLog', 'Direct order closed as stranded — its requester is no longer active and a return can only be answered by the person who raised it',
        'requiresReason', true,
        'sideEffects', jsonb_build_array('status returned -> cancelled', 'stamp decided_at', 'approval steps deliberately untouched'),
        'notifications', jsonb_build_array('notify the SFE Manager (in-app + Telegram, never email) — the requester''s login is disabled and the closer does not need telling'),
        'tests', jsonb_build_array(
          'an order whose requester is STILL EMPLOYED is refused — the return is theirs to answer',
          'a requester the employee master does not hold at all is refused as a directory problem, not read as a departure',
          'a status other than returned is refused',
          'the result is cancelled and never rejected',
          'no approval step is added, removed or decided',
          'no sales month is written — Finance owns the month'
        ),
        'allowedRoles', jsonb_build_array('Super Admin')
      )
    ),
    updated_at = now()
where module_key = 'direct_orders'
  and not exists (
    select 1 from jsonb_array_elements(actions) a where a->>'key' = 'close_orphaned'
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
      and a->>'key' = 'close_orphaned'
  ) then
    raise exception 'close_orphaned was not added — the direct_orders registry row is missing or was not matched';
  end if;
end $$;

commit;
