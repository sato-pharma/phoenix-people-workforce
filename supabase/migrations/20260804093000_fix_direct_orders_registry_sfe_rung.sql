-- Fix: the direct_orders workflow-registry row never learned about the SFE rung.
--
-- The registry row was seeded on 2026-07-18 (20260718140000_direct_orders_module_foundation.sql),
-- when the approval chain ran District Manager -> Regional -> National -> CEO. On 2026-08-03 the
-- owner rule "SFE validates first" landed (#1666), making the chain
--
--     SFE Manager -> [System Admin ack] -> management line -> CEO
--
-- and src/lib/direct-orders/approval-flow.ts + service.ts were both updated for it. The registry
-- row was NOT: no migration has touched it since the seed (live prod row was still version 1).
--
-- src/lib/direct-orders/service.ts runs TWO gates on a decision. The fine one (service.ts,
-- "the caller must be the assigned approver of the active step") was correctly taught about role
-- rungs. The coarse one — assertDirectOrderWorkflowTransition -> the registry's allowedRoles —
-- still held the pre-SFE lists, so the SFE Manager was refused on the rung that OPENS every single
-- direct order:
--
--     Forbidden: Workflow Registry does not allow SFE Manager to run direct_orders.return
--     from "pending_approval".
--
-- The same refusal applied to `approve_intermediate` and `reject`, so the SFE rung was actionable
-- by nobody except a Super Admin (who is in every list and also bypasses the fine gate). Every
-- direct order in production was frozen on step 1 from the day the rung shipped.
--
-- Fix: add "SFE Manager" to the three decision actions the SFE rung actually performs.
--   * approve_intermediate — SFE approves and the chain advances.
--   * return               — SFE sends the request back to the requester to fix.
--   * reject               — SFE refuses it outright.
--
-- Deliberately NOT added:
--   * approve_final — directOrderExpectedRoleChain always appends CEO, so the SFE rung is never
--                     the last one. Adding it here would let SFE finalize an order.
--   * submit        — SFE never raises its own field order (see the direct_orders permission
--                     matrix note in service.ts).
--   * reverse       — reversal is a requester-side action; SFE is not a requester.
--
-- Written as a targeted jsonb rewrite rather than a wholesale `actions` replacement so it cannot
-- silently revert any other edit made to this module through the Workflow Control UI. The
-- `@>` guard inside the CASE makes it idempotent — re-running never duplicates the role.

begin;

update public.workflow_registry_modules as m
set
    actions = (
        select jsonb_agg(
            case
                when elements.action->>'key' in ('approve_intermediate', 'reject', 'return')
                     and not (elements.action->'allowedRoles' @> '["SFE Manager"]'::jsonb)
                then jsonb_set(
                    elements.action,
                    '{allowedRoles}',
                    (elements.action->'allowedRoles') || '["SFE Manager"]'::jsonb
                )
                else elements.action
            end
            order by elements.ordinality
        )
        from jsonb_array_elements(m.actions)
             with ordinality as elements(action, ordinality)
    ),
    updated_by = 'system'
where m.module_key = 'direct_orders';

notify pgrst, 'reload schema';

commit;
