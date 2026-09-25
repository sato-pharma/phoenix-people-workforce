---
name: resignation-contract-scope-check-audit-2026-07
description: "PR #692 (merged 2026-07-02) added PER-RECORD scope checks (canSeeEmployee / canSeeContractRow) to runResignationWorkflow and runContractRenewalWorkflow. Both previously checked the actor ROLE only, so anyone holding generic workflow permission could approve, reject or complete a record for an employee outside their scope. Sibling of PR #689 fixing resignEmployeeAndOpenVacancy."
metadata: 
  node_type: memory
  type: project
  originSessionId: fff16f19-dbfc-4f6c-b9d2-ec238ca2d08a
---

PR #692 (merged 2026-07-02) added per-record scope checks (`canSeeEmployee` /
`canSeeContractRow`) to `runResignationWorkflow` (src/lib/resignations/service.ts)
and `runContractRenewalWorkflow` (src/lib/contracts/service.ts) — both previously
checked the actor's role only (via `assertResignationWorkflowTransition`/
`assertContractWorkflowTransition`), letting any actor with generic workflow
permission approve/reject/complete a record for an employee outside their scope.
Sibling of PR #689's fix to `resignEmployeeAndOpenVacancy`. Widened `access` params
from `Pick<AccessContext, "role">` to full `AccessContext` on both; contracts side
needed `getEmployeeDirectoryRows({ includeInactive: true })` (default excludes
inactive employees, which would have wrongly blocked legitimate actions like
`cancel` on already-inactive employees' requests).

Followed up with a full-codebase audit (parallel background agents) for the same
"role check without record-level scope check" pattern:
- **Already fine**: probation (#688), outstation (Super-Admin-only gate, no
  narrower role to bypass), vacation/leave (binds actor to record's live approval
  step), marketing-requests (binds to record's current step assignee), excuses
  (checks actor identity directly against row's manager_hr_id/employee_hr_id),
  coaching (`assertCanAccessEmployee` on every mutation).
- **One gap left, low severity**: `generateOfferDocuments` and `sendPreparedOffer`
  in src/lib/recruitment/applications.ts (~line 641, 665) skip the `getRequisition`
  scope check that every sibling function in the same file applies (`runApplicationTransition`,
  `prepareOffer`, `submitOfferForApproval`, `approveSeniorOffer`, `approveAndConvert`,
  `deleteApplication` all call it). Not currently exploitable — `offers`/`recruitment`
  are hard-boundary resources restricted to Super Admin + Talent Acquisition only
  (both company-wide-scoped already), so no narrower role can reach it today. Would
  become live if a scoped recruitment role is ever added.

**Why:** part of the ongoing IDOR/scope-check hardening sweep across workflow
domains (see [[sales-permission-security-audit-2026-07]], [[excuse-decision-race-condition-fix]]).

**How to apply:** user was told about the recruitment gap and explicitly declined
the follow-up fix (2026-07-02) — don't re-propose it unless asked, but it's fair
game to fix if a future task touches src/lib/recruitment/applications.ts or if a
scoped recruitment role is introduced.
