---
name: resignation-employee-scope-check
description: "OUTDATED IN PART (contradiction sweep 2026-10-02) — current: PR #692 (merged 2026-07-02) added PER-RECORD scope checks (canSeeEmployee / canSeeContractRow) to runResignationWorkflow and runContractRenewalWorkflow (see `resignation-contract-scope-check-audit-2026-07`). Older text follows: PR #689 (2026-07-02): resignEmployeeAndOpenVacancy now scope-checks the target employee via canSeeEmployee, not just role; runResignationWorkflow/runContractRenewalWorkflow still don't"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8e9b4490-fc7c-4dd6-99a9-edaac55824e1
---

`resignEmployeeAndOpenVacancy` (`src/lib/resignations/service.ts`) previously only
checked the caller's **role** (`assertResignationWorkflowTransition`) before
terminating/resigning an employee — never that the caller's **scope** covers the target
employee. Shipped in PR #689 (merged + verified live 2026-07-02): widened `access` from
`Pick<AccessContext, "role">` to full `AccessContext`, added
`canSeeEmployee(access ?? systemAccessContext, employee)` right after the role check and
before the mutation (reuses the already-loaded employee row, no extra directory fetch).
Propagated the type widening through `maybeRunNonRenewalTerminalLifecycle` and
`runContractRenewalWorkflow`'s `input.access` in `src/lib/contracts/service.ts`. New static
test: `tests/resignation-scope-check.test.ts`.

**Why:** not exploitable under the static `defaultPermissionMatrix` today (only roles with
`resignations:create` reach this code), but `"resignations"` isn't in
`hardBoundaryAllowedActions`, so a future `role_permission_overrides` runtime grant could
let an out-of-scope role terminate an out-of-scope employee. Also closed the gap for the
direct API caller `app/api/employees/[hrId]/resign/route.ts`, which had no per-record scope
check at all before this.

**Deliberately NOT done in this same PR** (confirmed by direct code read, not assumption):
`runResignationWorkflow` (transitions an existing resignation record: approve/reject/
complete/cancel/reopen) and `runContractRenewalWorkflow` (transitions an existing contract
renewal request) have the identical role-only gap — neither calls
`canSeeEmployee`/`canSeeHrScopedRecord` before mutating. Left as a follow-up per explicit
user decision to keep PR #689 narrowly scoped; spawned as background task `task_d0ec82fe`,
started by the user in a separate session same day.

**Also deliberately NOT done — and should stay that way:** threading `access` through the
probation-termination call site. See [[probation-scope-broader-than-generic-canseeemployee]]
for why that would be a regression, not a fix.

**How to apply:** before extending this scope-check pattern to any other caller of
`resignEmployeeAndOpenVacancy` (or any function with its own upstream domain-specific scope
gate), check whether that upstream gate is broader than `canSeeEmployee` for any role that
uses it — don't assume "no access passed" always means "gap to close."
