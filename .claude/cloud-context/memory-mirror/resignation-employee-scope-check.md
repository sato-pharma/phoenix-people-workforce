---
name: resignation-employee-scope-check
description: "PR #689 (2026-07-02): resignEmployeeAndOpenVacancy scope-checks the target employee via canSeeEmployee, not just role; its follow-up PR #692 (merged the same day) gave runResignationWorkflow/runContractRenewalWorkflow per-record checks too (canSeeEmployee / canSeeContractRow) — the gap is closed, do not re-open it. Never thread access through the probation-termination call site."
metadata: 
  node_type: memory
  type: project
  originSessionId: 8e9b4490-fc7c-4dd6-99a9-edaac55824e1
  modified: 2026-10-02T16:38:58.651Z
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

**Deliberately NOT done in this same PR — and since closed by the follow-up PR #692 (merged
2026-07-02):** `runResignationWorkflow` (transitions an existing resignation record: approve/reject/
complete/cancel/reopen) and `runContractRenewalWorkflow` (transitions an existing contract
renewal request) had the identical role-only gap when PR #689 shipped. PR #692 added per-record
scope checks to both — `canSeeEmployee` on the resignation side, `canSeeContractRow` on the contracts
side (which needed `getEmployeeDirectoryRows({ includeInactive: true })` so actions such as `cancel`
on an already-inactive employee's request are not wrongly blocked) — see
[[resignation-contract-scope-check-audit-2026-07]]. Kept narrow at the time per explicit user
decision; the follow-up ran as background task `task_d0ec82fe` the same day.
**Superseded 2026-10-02:** previously "`runResignationWorkflow`/`runContractRenewalWorkflow` still don't scope-check" — PR #692 (`resignation-contract-scope-check-audit-2026-07`).

**Also deliberately NOT done — and should stay that way:** threading `access` through the
probation-termination call site. See [[probation-scope-broader-than-generic-canseeemployee]]
for why that would be a regression, not a fix.

**How to apply:** before extending this scope-check pattern to any other caller of
`resignEmployeeAndOpenVacancy` (or any function with its own upstream domain-specific scope
gate), check whether that upstream gate is broader than `canSeeEmployee` for any role that
uses it — don't assume "no access passed" always means "gap to close."
