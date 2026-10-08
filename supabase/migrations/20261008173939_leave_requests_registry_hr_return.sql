-- leave_requests_registry_hr_return
--
-- WHAT THIS CHANGES: the `leave_requests` workflow-registry module (the vacation engine's legacy
--   key, see src/lib/vacation/workflow.ts) gains one action, `hr_return` — pending_hr -> returned,
--   allowed for Super Admin and CEO, the same two roles as hr_approve / hr_reject. It also flips
--   `manager_return.requiresReason` to false. Nothing else in the registry is touched.
-- WHY: owner, 2026-10-08 — every vacation approval, any type, must be able to "return for edit",
--   with or without a comment. HR could not return at all, and the registry is FAIL-CLOSED on role
--   AND on the status an action leaves from: `manager_return` is seeded from `pending_manager`
--   only, so an HR return at `pending_hr` would be refused with "Workflow Registry does not allow
--   ... from pending_hr". The app code asks for `hr_return` only at `pending_hr`. The reason flag
--   follows the new rule that a plain "Return for edit" carries no comment.
-- ROLLBACK: remove the `hr_return` element from leave_requests.actions and set manager_return's
--   requiresReason back to true:
--     update public.workflow_registry_modules m
--        set actions = (select coalesce(jsonb_agg(a), '[]'::jsonb) from jsonb_array_elements(m.actions) a where a->>'key' <> 'hr_return')
--      where m.module_key = 'leave_requests';
--   Additive and idempotent; applying it before the code ships changes nothing for anyone, because
--   no running code asks for `hr_return` yet.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: one jsonb element appended to one row.

begin;

update public.workflow_registry_modules as m
set
    actions = (
        select jsonb_agg(
            case
                when elements.action->>'key' = 'manager_return'
                then jsonb_set(elements.action, '{requiresReason}', 'false'::jsonb)
                else elements.action
            end
            order by elements.ordinality
        )
        from jsonb_array_elements(m.actions)
             with ordinality as elements(action, ordinality)
    ) || jsonb_build_array(
        jsonb_build_object(
            'key', 'hr_return',
            'label', 'HR return for edit',
            'from', jsonb_build_array('pending_hr'),
            'to', 'returned',
            'allowedRoles', jsonb_build_array('Super Admin', 'CEO'),
            'requiresReason', false,
            'auditLog', 'Leave returned to employee for edit by HR',
            'sideEffects', jsonb_build_array('capture return reason'),
            'notifications', jsonb_build_array('notify employee'),
            'tests', jsonb_build_array('HR can return leave to employee')
        )
    ),
    updated_by = 'system'
where m.module_key = 'leave_requests'
  and not exists (
      select 1 from jsonb_array_elements(m.actions) as existing(action)
      where existing.action->>'key' = 'hr_return'
  );

commit;
