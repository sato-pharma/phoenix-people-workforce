-- Vacation — close_orphaned (2026-10-15)
--
-- WHAT. (1) Lets a vacation request be stored as `cancelled`: the live v2_vacation_requests_status_check
-- allowed only needs_assignment, pending_manager, pending_hr, approved, rejected and returned, although
-- the `leave_requests` workflow registry has declared `cancelled` all along. (2) Adds the registry
-- action `close_orphaned` (returned -> cancelled, Super Admin only) to `leave_requests`.
--
-- WHY. `returned` is answerable by exactly one person: resubmitVacationRequest refuses anyone who is
-- not the employee who submitted the request. When that employee resigns their login is disabled,
-- nothing expires a `returned` request and it is in nobody's queue. The Needs You board finds these
-- (src/lib/approvals/orphaned-requests.ts) and used to say "no screen in Phoenix can clear it yet".
-- The direct-order twin of this (20261008040000) closed five stranded orders that had to be cleared by
-- hand-written SQL; a vacation must not repeat that. Production holds NO returned vacation today, so
-- this lands before the first one strands rather than after.
--
-- 'to' IS `cancelled`, NEVER `rejected`. Nobody turned the request down, and `rejected` would inflate
-- every approver's rejection count. It is also never DELETED: admin_delete would destroy the request,
-- its events and its approval steps, and the record of who approved what is worth keeping.
--
-- NO NEW REGISTRY STATUS. `cancelled` and `returned` are both already declared in `leave_requests`.
-- The 2026-08-05 outage (every direct_orders transition dead) came from an action naming an
-- UNDECLARED status: the loader skips the whole module. The loader simulation below runs again here.
--
-- ROLLBACK. Remove the action from `leave_requests`.actions where key = 'close_orphaned', and, only
-- if no row is `cancelled`, restore the six-value status check. Reverting the pull request does not
-- reverse an applied migration; only another migration does.

begin;

alter table public.v2_vacation_requests
  drop constraint if exists v2_vacation_requests_status_check;

alter table public.v2_vacation_requests
  add constraint v2_vacation_requests_status_check
  check (status = any (array[
    'needs_assignment'::text, 'pending_manager'::text, 'pending_hr'::text,
    'approved'::text, 'rejected'::text, 'returned'::text, 'cancelled'::text
  ]));

update public.workflow_registry_modules
set actions = actions || jsonb_build_array(
      jsonb_build_object(
        'key', 'close_orphaned',
        'label', 'Closed a returned vacation request whose employee has left the company — nobody could ever resubmit it',
        'from', jsonb_build_array('returned'),
        'to', 'cancelled',
        'auditLog', 'Vacation request closed as stranded — its employee is no longer active and a return can only be answered by the employee who submitted it',
        'requiresReason', true,
        'sideEffects', jsonb_build_array('status returned -> cancelled', 'approval steps deliberately untouched', 'no balance is touched — a returned request was never approved'),
        'notifications', jsonb_build_array('none — the employee has left and the closer does not need telling'),
        'tests', jsonb_build_array(
          'a request whose employee is STILL EMPLOYED is refused — the return is theirs to answer',
          'an employee the employee master does not hold at all is refused as a directory problem, not read as a departure',
          'a status other than returned is refused',
          'the result is cancelled and never rejected',
          'no approval step is added, removed or decided'
        ),
        'allowedRoles', jsonb_build_array('Super Admin')
      )
    ),
    updated_at = now()
where module_key = 'leave_requests'
  and not exists (
    select 1 from jsonb_array_elements(actions) a where a->>'key' = 'close_orphaned'
  );

-- `version` is deliberately NOT set: workflow_registry_modules_touch bumps it.

-- Simulate the loader before committing: an action naming an undeclared status gets the whole module
-- skipped at runtime, surfacing only as a log line. Failing here rolls the transaction back instead.
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
    where m.module_key = 'leave_requests'
      and a->>'to' not in ('unchanged', 'deleted')
      and not exists (
        select 1 from jsonb_array_elements(m.statuses) s where s->>'key' = a->>'to'
      )
    union all
    select format('action %s <- undeclared source %L', a->>'key', f.value)
    from public.workflow_registry_modules m,
         jsonb_array_elements(m.actions) a,
         jsonb_array_elements_text(a->'from') f(value)
    where m.module_key = 'leave_requests'
      and not exists (
        select 1 from jsonb_array_elements(m.statuses) s where s->>'key' = f.value
      )
  ) problems;

  if bad is not null then
    raise exception 'leave_requests registry would be SKIPPED by the loader: %', bad;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from public.workflow_registry_modules m,
         jsonb_array_elements(m.actions) a
    where m.module_key = 'leave_requests'
      and a->>'key' = 'close_orphaned'
  ) then
    raise exception 'close_orphaned was not added — the leave_requests registry row is missing or was not matched';
  end if;
end $$;

commit;
