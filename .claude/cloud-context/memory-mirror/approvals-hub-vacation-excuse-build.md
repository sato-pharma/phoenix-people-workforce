---
name: approvals-hub-vacation-excuse-build
description: "The Approvals Hub (Vacation + Excuse + Plan) is BUILT and LIVE in both shells — app/(admin)/admin/approvals-hub and app/employee-portals/approvals-hub, wired in system-navigation.ts, with pending-count APIs. Not open work. Keep for the access-model rulings (Super Admin has NO turn-jumping bypass; NSM never receives an excuse; HR-acknowledge is Super-Admin-only) and the reusable plan-workflow traps (the 2nd approval is hard-wired to the CEO; `ceo_approved` is a dead legacy enum — gate on `final_approved`)."
metadata: 
  node_type: memory
  type: project
  originSessionId: db90c0ef-8e72-4dda-bc89-00d392e2760c
  modified: 2026-09-26T03:07:55.599Z
---

The Approvals Hub consolidates Vacation, Excuse and Weekly/Monthly Plan approvals into a dedicated
sidebar section in BOTH shells (built 2026-07-04/05 per [[project-leave-excuse-approver-model]],
shipped and production-verified). Each module is its own page with tabs (Response awaiting /
coming-to-you · History · My Requests · All-Decisions [Super-Admin only]), a per-request page with a
stage tracker + SLA/overdue chip, and Approve(1-click)/Reject/Return/HR-Acknowledge actions (reject
and return require a reason). It reuses the existing workflow engines
(`decideVacationRequest`/`decideExcuseRequestAsManager`/`decideEmployeePlan`/`acknowledgeEmployeePlan`)
— **no approval-workflow logic was changed**, only surfaced.

**Where it lives:** `app/(admin)/admin/approvals-hub/page.tsx`,
`app/employee-portals/approvals-hub/page.tsx`, the per-module pages at
`/{admin|employee-portals}/approvals/{vacation|excuse|plan}(/[id])`, the pending-count APIs under
`app/api/approvals*/`, `src/lib/approvals-hub/service.ts`, `src/components/approvals-hub/*`, wired in
`src/config/system-navigation.ts`. 🔴 **Three related surfaces now coexist — `approvals/`,
`approvals-hub/` and `action-center/`** — the later Actions consolidation was built BESIDE this, not
replacing it, so check which one a change belongs in before editing.

## The access model (owner rulings — do NOT "fix" back)

- 🔴 **Super Admin has NO turn-jumping bypass** (owner: "if it is the manager's turn to respond system
  admin cannot respond until his turn comes"). This surfaced and fixed a PRE-EXISTING violation in the
  plan workflow (`assertManagerReviewer`/`assertCeoReviewer`/`resolveApproverPlanStage` let SA decide
  any manager or CEO stage instantly) — the bypasses were removed. **HR-Acknowledge stays Super-Admin-only.**
  Vacation was audited and found already compliant. See [[project-leave-excuse-approver-model]] for the
  full per-module rule.
- **Excuse is single-step, manager-only — NO HR-acknowledge stage at all**, so unlike vacation/plans
  Super Admin gets ZERO special excuse authority (the manager-visibility functions widen only to
  `scope==="system"`, never to the Super Admin role).
- 🔴 **The NSM never receives an excuse** — excuse is direct-manager-only with no manager-of-manager
  step, and NSM-level excuse submissions route through Head Office, so the NSM's Excuse Approvals page
  was always empty. Vacation and Excuse portal visibility are SEPARATE flags: `showVacationApprovalsTab`
  (full role list) vs `showExcuseApprovalsTab` (same list **minus National Sales Manager**); Plans has
  its own flag. (Consistent with the standing NSM-scope rule.)
- **Nav gating:** admin = Super Admin/CEO (Finance Mgr/Financial Advisor reach vacation via `leave:read`,
  registered so the `/admin/**` `admin:read` catch-all doesn't block them); portal = the plan-builder /
  approver roles (DM/RM/NSM/PM/GPM/Marketing Mgr/Manager).
- **`isAllVacationVisibility` (Super Admin/system only) is the real vacation-visibility gate — NOT
  `isHrAuthorityRole`**, which wrongly includes Talent Acquisition. One exported source of truth.

## Reusable plan-workflow traps

- 🔴 **The plan workflow hard-wires every plan's 2nd approval to the CEO** (`weekly-planning/workflow.ts`
  + `assertCeoReviewer`) — there is NO manager-of-manager step in code, so the owner's
  mgr→mgr-of-mgr→HR model only matches the PM case today. Honoring it fully is a workflow + DB-function
  migration, **DEFERRED** (along with the Marketing Requests Approvals module and the who-approves-whom
  routing corrections: Finance Mgr approves reports, Financial Advisor↔Finance Mgr, CEO↔Financial Advisor).
- 🔴 **`ceo_approved` is a legacy CHECK-constraint enum the live workflow NEVER produces** — the real
  transition is `manager_approved → final_approved` DIRECTLY (0 production rows ever held `ceo_approved`).
  Gate HR-acknowledge, the awaiting bucket and the stage label on **`final_approved`** ("HR acknowledgement",
  actionable), with `hr_acknowledged` as the terminal "Completed". Gating on `ceo_approved` makes the
  Acknowledge button never appear for any real plan.
- **SLA thresholds:** leave = 3 days, excuse = 2 days, plan = 2 days (match `action-center-hub.tsx`).
- **A post-mutation notify must be isolated** — `decideEmployeePlan`'s reject/return path and
  `decideExcuseRequestAsManager` originally ran the employee-notify as a plain unguarded `await`, so a
  notify throw reported an already-succeeded DB mutation as **failed** (a manager sees "failed" and
  re-clicks a decision that went through). Wrap such calls in `Promise.allSettled` like `notifyPlanSubmitted`
  already does.

## Two environment traps found here

- **The dev-auth gate is `NODE_ENV=development`, not which DB it points at** — `/api/dev-auth?role=X&hrId=Y`
  impersonation works against PRODUCTION data, which is how a role-based e2e was run against prod with
  bounded, reversible synthetic rows after staging was unavailable. (Ground-truth-verify every e2e action
  with a direct DB query, not the HTTP response — an action can report failed while the mutation
  succeeded.)
- **A stale `.next/dev/types/routes.d.ts`** (Next.js's own auto-generated dev route-types, not
  source-controlled, left over from a prior `next dev`) makes a pre-push typecheck fail with garbled
  syntax errors unrelated to any real change — fix is `rm -rf .next`, not a code fix. Check this first
  before assuming a regression.
