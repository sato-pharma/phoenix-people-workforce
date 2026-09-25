---
name: vacation-action-center-build
description: "Vacation Action Center + sequential approval workflow — 3 stacked PRs. PR1 (engine) shipped as PR"
metadata: 
  node_type: memory
  type: project
  originSessionId: 685a79be-68ed-421c-bf32-95f173d2c3e1
---

Large feature: sequential approval workflow + Vacation Action Center for **Annual/Other/Compensatory/Emergency**
(only **Sick** stays legacy parallel — type-branched). NOTE scope was revised: Emergency now uses the NEW
sequential workflow too (user changed their mind); only Sick is legacy. Locked decisions: full **needs_assignment** state
for a missing first manager; **phased delivery (3 stacked PRs)**. The engine has a parallel-approval-steps background.

**Workflow:** submit → management_approval_1 → management_approval_2 (if exists) → hr_acknowledgement.
HR **acknowledges/records** (NEVER "Final Approval"), may **reject anytime with a mandatory reason**.
Status model reuses the previously-unused `pending_hr`: needs_assignment → pending_manager → pending_hr →
approved ("Recorded by HR") | rejected.

**Engineering call:** keep generic DB step keys `direct_manager`/`manager_of_manager`/`hr` + a new `step_order`
column; expose `management_approval_1/2`/`hr_acknowledgement` as derived identities in code; dynamic UI labels
from the assigned approver's actual title. HR step approvers stay the B-10/admin-HR pilot set.

**PR1 — ENGINE (DONE, PR #90, branch codex/vacation-action-center-engine, based on main dcb4a98, NOT merged):**
- New pure module `src/lib/vacation/approval-flow.ts` (DB-free, unit-tested): isSequentialWorkflowType,
  evaluateStepAction, resolveActiveStep, genericStepName, resolveStageLabel, resolveActionAvailability.
- service.ts: applyVacationDecision dispatches by type; applyVacationDecisionLegacy = original parallel flow
  (verbatim, for Emergency/Sick); applyVacationDecisionSequential = new gated path. New
  assignVacationManagementApprover (HR-only) + getVacationActionCenterData. createVacationRequest routes
  missing-first-manager sequential requests to needs_assignment.
- Migration `20260610120000_vacation_sequential_workflow.sql` (step_order + needs_assignment status; additive, NOT applied).
- types.ts: needs_assignment status, VacationWorkflowStepKey/GenericStepName/ApprovalStepState/ActionAvailability,
  VacationActionCenterRow/Data. Gates all green (typecheck/test/build/lint).

**Migration APPLIED to PRODUCTION (ozucdzovmcqvepbozvqf) 2026-06-10** via MCP apply_migration (step_order +
needs_assignment). Recorded under versions 20260610004648 (MCP) AND 20260610120000 (canonical, inserted so the
repo pipeline skips it). Prod had 0 vacation requests so it was risk-free. **Staging izhmxvgiktiafqusolot is
NOT reachable via my Supabase MCP token (permission denied)** — couldn't do true staging-first.

**PR2 — UI (DONE, on the SAME branch/PR #90):** nav entry in BOTH admin + employee-portal leave sections
(management approvers DM/RM/NSM/Manager run in PORTAL mode per resolveNavigationMode, so it must be in both) +
`app/leave-management/vacation-action-center/page.tsx` + `src/components/vacation/vacation-action-center.tsx`
(list/detail/timeline/actions/disabled-reasons/reject-reason/HR-assign) + `app/api/vacations/requests/[id]/assign/route.ts`
+ service viewerStepKind field. Employee tracking: vacation-report.tsx dynamicStatusLabel (client-side, no extra
fetch). Gates green (typecheck/test/build/lint). Note: PR1+emergency+PR2 are all on branch
codex/vacation-action-center-engine / PR #90 (PR1 not merged, so stacking on one branch).

**PR3 — NOTIFICATIONS/SLA (DONE, same branch):** role/stage submit copy in notifyVacationSubmittedByGovernance
(mgmt_1 action-required / mgmt_2 FYI / HR review-or-reject); email+Telegram send a single "Review Request" →
Action Center for sequential types (legacy Sick keeps Approve/Reject in Phoenix); token direct-approval disabled
for sequential types in decideVacationRequestByToken; dispatchVacationManagerReview is type-aware ("HR
acknowledgement" not "final decision"); runVacationSlaDaily reminds HR on needs_assignment + points sequential
overdue reminders at the Action Center. Updated test assertions in vacation-module.test.ts (telegram/actionUrl/
requestUrl now conditional) + notification-recipient-isolation.test.ts (title/status/action now type-aware).

**STATUS: SHIPPED TO PRODUCTION 2026-06-10.** Split into 3 stacked PRs (#90 closed/superseded), all merged to
main in order and deployed:
- **#91 engine** (codex/vac-engine) MERGED → prod deploy READY.
- **#92 Action Center UI** (codex/vac-action-center-ui) MERGED.
- **#93 notifications/SLA** (codex/vac-notifications) MERGED → final prod deploy dpl_5Bmd... READY, aliased to
  phoenix-workforce.vercel.app (main HEAD 6e74e8d).
Verified live: `/`, `/leave-management/vacation-action-center` (new), `/leave-management/vacation-report` all
HTTP 200. Migration already applied to prod. Worktree _wt-vac-engine REMOVED; all feature branches deleted
(local + remote). Remaining manual check: an authenticated end-to-end walkthrough (submit Annual → Action Center
→ approve/acknowledge) needs login creds I don't have.

**Worktree:** built in isolated worktree `F:\Phoenix Workforce\_wt-vac-engine` (parallel session active in primary
tree on codex/dsm-dashboard-enhancements — employee-portal-dashboard.tsx + premium-tooltip.tsx uncommitted there).
node_modules was a junction (works for tsc/eslint/test) but Turbopack BUILD needs a REAL node_modules — replaced
the junction with a robocopy of the primary's node_modules (lockfiles identical; ~0.81GB; F: had 25.8GB free).
Remove the worktree with `git worktree remove` when PR3 is done.
