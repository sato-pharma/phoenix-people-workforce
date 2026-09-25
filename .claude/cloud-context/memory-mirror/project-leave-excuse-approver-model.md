---
name: project-leave-excuse-approver-model
description: "Owner-confirmed CORRECT approver model for Leave/Vacation + Excuse requests, and the org-structure principle governing all approvals."
metadata: 
  node_type: memory
  type: project
  originSessionId: db90c0ef-8e72-4dda-bc89-00d392e2760c
---

Owner locked this on 2026-07-04 during an approvals-redesign planning session (part of a
larger "redirect every approval to a central place + save every action + give each its own
page" effort — the workflow logic itself is NOT being changed yet; this is the reference model).

**Governing principle #1 (applies to EVERY approval type, not just leave):** a role is only an
approver if it has BOTH (1) the permission AND (2) actual direct reports in the organogram.
No direct reports = not an approver, regardless of what `defaultPermissionMatrix` grants.

**Governing principle #2 — Super Admin (cross-cutting, EVERY approval type):** Super Admin can
act on anyone's request, BUT can never OVERRIDE an already-made decision, and can never
SUBSTITUTE for a step that belongs to another actor — in a manager → manager-of-manager →
acknowledgment chain he cannot accept instead of the manager or manager-of-manager. He acts
only in a step genuinely his (the final HR-acknowledge step), or where he personally is the
actual assigned manager (same as anyone else) — never chain-bypass or reversal, never deciding
while it's still someone else's turn. **RE-CONFIRMED 2026-07-05, re-worded for precision:** "if
it is the manager's turn to respond, system admin cannot respond until his turn comes" — his own
place in the chain is the HR-acknowledge step, not a stand-in for manager/CEO.

**Status per module as of 2026-07-05 (re-audited live against real prod data + fixed where wrong):**
- **Vacation** — ALREADY fully compliant, no code change needed.
  `getPendingVacationApprovalStepForActor` in `src/lib/vacation/service.ts` only lets Super Admin
  bypass for `stepKey==="hr"` specifically (`isAllVacationVisibility` gate) — never
  `direct_manager`/`manager_of_manager`; those match purely on real hrId identity
  (`approvalStepMatchesAccess`), no role shortcut. Even has a separation-of-duties safeguard on
  the HR step. This is the reference-correct implementation the other two modules were fixed to match.
- **Plans** — FIXED 2026-07-05 (was violating the rule, confirmed via live e2e testing on real
  production data): `assertManagerReviewer`/`assertCeoReviewer`/`resolveApproverPlanStage` in
  `src/lib/weekly-planning/service.ts` had explicit `if (access.role === "Super Admin") return`
  early-bypasses letting Super Admin decide ANY plan's manager or CEO stage instantly, regardless
  of the real assigned person. Removed all three; Super Admin now only acts where he's literally
  the assigned manager (hrIdsMatch) or CEO (role==='CEO' only, no exception) — HR-acknowledge
  (`acknowledgeEmployeePlan`/`isHrReviewer`, Super-Admin-only) is untouched and still works, live
  re-verified end-to-end (manager approve → CEO approve → SA acknowledge all succeeded; SA blocked
  with Forbidden when trying to jump the manager or CEO stage of someone else's plan). Also fixed
  the two matching UI-flag mirrors in `approvals-hub/service.ts` (`isEditRequestDecision`,
  `canRequestVisitDetails` — both manager-stage actions, same narrowing applied).
- **Excuse** — briefly OVER-widened by me earlier on 2026-07-05 then reverted same day: I had
  added a Super-Admin bypass to `getManagerPendingExcuses`/`decideExcuseRequestAsManager` (to fix
  a real, separate bug — Super Admin couldn't see ANY pending excuse because the code checked
  `scope==="system"`, which a real Super Admin session never has, only `scope==="company"`). Owner
  clarified the correct fix is narrower: since excuse has NO HR-acknowledge stage at all
  (single-step: manager decides only), Super Admin should get NO special excuse authority
  whatsoever — reverted to `scope==="system"` only (background/system-actor calls exclusively; a
  real user session, including Super Admin, must be the literal assigned manager to decide an
  excuse). Live re-verified: SA correctly gets Forbidden on someone else's excuse; the real
  assigned manager still decides normally.

**Leave/Vacation + Excuse — confirmed approvers (each for their own org-downward reports):**
- Super Admin — anyone (system-wide)
- CEO — own direct reports + the Financial Advisor
- Financial Advisor — approves the Finance Manager ONLY (special person-to-person routing)
- Finance Manager — his own direct reports
- Manager, District Manager, Regional Manager, National Sales Manager, Product Manager,
  Group Product Manager, Marketing Manager — each their own direct reports

**Confirmed NON-approvers:** SFE Manager + Training Manager (have no reports in the organogram),
Talent Acquisition, Employee, Medical Rep.

**Deltas vs. current code (gaps to reconcile if/when we implement — NOT yet changed):**
1. Finance Manager has NO `leave:approve` today (permissions.ts) — model says he approves reports.
2. Financial Advisor has `leave: read/create` only today; approving the Finance Manager is a
   specific person→person route no generic role rule expresses. Needs special handling.
3. SFE Manager + Training Manager currently DO hold `leave:approve` in the matrix; today's code
   would let them approve if anyone were ever placed under them. Model forbids it (no reports).

Excuse gate today is relationship-based (requester's direct manager via manager_hr_id, or Super
Admin) — see [[approvals-history-table-name-bug]], [[vacation-action-center-build]]. Leave uses
the step/manager-chain binding. Broader audit context: [[hr-approval-authority]],
[[job-title-not-a-permission-source]].
