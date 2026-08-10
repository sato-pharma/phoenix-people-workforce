-- Activate the Finance Manager (Ahmed El Maraghy, B-185) as a working approver in two modules.
--
-- Context: the Finance Manager login has existed since 2026-05-02 and had never been used — zero
-- sessions, zero login attempts. The owner activated it on 2026-08-10, and two of the duties he
-- wants it to perform are blocked by DATA, not by code, so they live here.
--
-- Both parts are targeted rewrites rather than wholesale replacements, and both are idempotent, so
-- re-running cannot duplicate a role or clobber an unrelated edit made through an admin UI.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 1 — leave_requests registry: let the Finance Manager decide his own team's vacations.
--
-- He is the direct manager of three active head-office employees (OF-0001 Ahmed Mousa, A-1 Mahmoud
-- Ibrahim, A-4 Mohamed Zain), so their vacation requests route to him. The owner granted the role
-- `leave: approve` in src/lib/auth/permissions.ts in the same change.
--
-- That grant alone is NOT enough. A vacation decision passes THREE gates:
--   1. assertPermission(access, "leave", "approve")            — the permission matrix (granted now)
--   2. getPendingVacationApprovalStepForActor                  — "are you the assigned approver?"
--   3. assertLeaveWorkflowTransition -> the registry allowedRoles below  — FAIL-CLOSED on role
--
-- Gate 3 listed every management rung but not Finance Manager, so he would have passed 1 and 2 and
-- then hit:
--
--     Forbidden: Workflow Registry does not allow Finance Manager to run
--     leave_requests.manager_approve from "pending_manager".
--
-- Exactly the failure 20260804093000_fix_direct_orders_registry_sfe_rung.sql describes for the SFE
-- rung, and the reason this is a migration and not a settings change: the Workflow Control UI is
-- read-only (WORKFLOW_CONTROL_EDIT_ENABLED = false).
--
-- The three actions added are the ones a direct manager actually performs on the `pending_manager`
-- rung. Deliberately NOT added:
--   * hr_approve / hr_reject — stage 2, and it must stay ["Super Admin", "CEO"]. He approves as the
--     manager, the request moves to `pending_hr`, and HR finalises. Adding him here would let one
--     person carry a vacation from request to final approval with no second pair of eyes.
--   * admin_create / admin_update / admin_delete — HR administration, not a manager's decision.
--   * submit — he raises his own leave through the normal employee path, which is not role-gated.
--
-- Note "leave_requests" is a LEGACY module key for the vacation engine (see the comment in
-- src/lib/vacation/workflow.ts) — it is not a stale table reference.
update public.workflow_registry_modules as m
set
    actions = (
        select jsonb_agg(
            case
                when elements.action->>'key' in ('manager_approve', 'manager_reject', 'manager_return')
                     and not (elements.action->'allowedRoles' @> '["Finance Manager"]'::jsonb)
                then jsonb_set(
                    elements.action,
                    '{allowedRoles}',
                    (elements.action->'allowedRoles') || '["Finance Manager"]'::jsonb
                )
                else elements.action
            end
            order by elements.ordinality
        )
        from jsonb_array_elements(m.actions)
             with ordinality as elements(action, ordinality)
    ),
    updated_by = 'system'
where m.module_key = 'leave_requests';

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 2 — marketing_requests: switch on the Finance Execution step and point it at a real seat.
--
-- Owner instruction, 2026-08-10: "Ahmed is the next step after CEO — the finance person that
-- executes transactions after CEO approval."
--
-- The live chain is manager_chain(1) -> sfe_validation(2) -> marketing_review(3) -> ceo_approval(4),
-- and BOTH finance steps are inactive. 20260621130000_marketing_chain_sfe_validate_no_finance.sql
-- turned them off on the reasoning that the Finance Manager "executes approved requests — they are
-- not an approver." The owner has now decided the execution itself is a step on the chain, so the
-- step comes back — as the terminal rung, after the CEO.
--
-- `finance_execution` is the correct row and `finance_review` is not. The difference is
-- terminal_status, which public.phx_decide_marketing_request_step reads on the final rung:
--
--     v_terminal_status := coalesce(v_step.terminal_status, 'approved');
--     v_is_execution    := (v_terminal_status = 'active');
--     update marketing_requests set
--       executed_at = case when v_is_execution then p_decided_at else null end,
--       status      = v_terminal_status ...
--
-- finance_execution carries terminal_status = 'active', so approving it sets the request to `active`
-- and stamps executed_at on both the request and the step — that is what "executed" means here.
-- finance_review carries terminal_status = NULL, so it would settle to `approved` and never stamp
-- executed_at: a review, not an execution. It stays inactive.
--
-- assigned_role MUST change at the same time. The row points at 'Financial Advisor', and there are
-- ZERO Financial Advisor logins — app_auth_users_role_check does not even permit that value, so one
-- cannot be created without another migration. (Adel El Sayed, OF-0002, holds the job TITLE but his
-- login role is 'Employee'; job titles never grant access — see resolveEmployeeAccessRole.) Turning
-- the step on without re-pointing it would make roleApproverHrId return null and
-- createMarketingApprovalSteps throw `marketing_approver_not_resolved` — breaking EVERY marketing
-- request submission company-wide, not just this step. 'Finance Manager' resolves deterministically
-- to B-185, the only active holder.
--
-- Safe on in-flight work: approval steps are materialised per request at SUBMIT time, so this only
-- affects requests submitted from here on. Existing rows keep the chain they were created with.
update public.marketing_workflow_steps
set
    assigned_role = 'Finance Manager',
    active        = true,
    updated_at    = now()
where step_code = 'finance_execution'
  and (assigned_role is distinct from 'Finance Manager' or active is distinct from true);

notify pgrst, 'reload schema';

commit;
