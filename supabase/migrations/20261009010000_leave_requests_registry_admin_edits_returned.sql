-- leave_requests_registry_admin_edits_returned
--
-- WHAT THIS CHANGES: the `leave_requests` workflow-registry module (the vacation engine's legacy
--   key, see src/lib/vacation/workflow.ts). `admin_update` and `admin_delete` may now leave from
--   `returned` and `needs_assignment` as well as the six statuses they already list, and the module
--   gains the `needs_assignment` status it was missing. Nothing else in the registry is touched.
-- WHY: the Admin controls panel on a leave request offers every status, but the registry is
--   FAIL-CLOSED on the status an action leaves from, so a request returned to the employee (VAC-0653,
--   2026-10-08) or waiting for an approver to be assigned could be neither edited nor deleted by the
--   Super Admin — "Workflow Registry does not allow ... from returned". Both remain Super Admin only.
-- ROLLBACK: remove the two statuses from both actions' `from` and drop the status entry:
--     update public.workflow_registry_modules m
--        set actions = (select jsonb_agg(case when a->>'key' in ('admin_update','admin_delete')
--                         then jsonb_set(a, '{from}', (select jsonb_agg(f) from jsonb_array_elements(a->'from') f
--                                                     where f #>> '{}' not in ('returned','needs_assignment')))
--                         else a end order by o) from jsonb_array_elements(m.actions) with ordinality x(a, o)),
--            statuses = (select jsonb_agg(s order by o) from jsonb_array_elements(m.statuses) with ordinality y(s, o)
--                         where s->>'key' <> 'needs_assignment')
--      where m.module_key = 'leave_requests';
--   Additive and idempotent: a status already listed is not added twice.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: two jsonb arrays widened on one row.

begin;

update public.workflow_registry_modules as m
set
    actions = (
        select jsonb_agg(
            case
                when elements.action->>'key' in ('admin_update', 'admin_delete')
                then jsonb_set(
                    elements.action,
                    '{from}',
                    (elements.action->'from')
                      || case when (elements.action->'from') ? 'returned' then '[]'::jsonb else '["returned"]'::jsonb end
                      || case when (elements.action->'from') ? 'needs_assignment' then '[]'::jsonb else '["needs_assignment"]'::jsonb end
                )
                else elements.action
            end
            order by elements.ordinality
        )
        from jsonb_array_elements(m.actions) with ordinality as elements(action, ordinality)
    ),
    statuses = case
        when exists (select 1 from jsonb_array_elements(m.statuses) s where s->>'key' = 'needs_assignment')
        then m.statuses
        else m.statuses || jsonb_build_array(
            jsonb_build_object('key', 'needs_assignment', 'label', 'Needs HR Assignment', 'terminal', false)
        )
    end,
    updated_by = 'system'
where m.module_key = 'leave_requests';

commit;
