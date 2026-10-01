---
name: probation-scope-broader-than-generic-canseeemployee
description: "Do not thread access into applyDecisionSideEffects/resignEmployeeAndOpenVacancy for probation terminations — canReadProbationEmployee is deliberately broader than canSeeEmployee for PM/GPM/NSM/RM"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8e9b4490-fc7c-4dd6-99a9-edaac55824e1
---

`src/lib/probation/service.ts`'s `applyDecisionSideEffects` calls
`resignEmployeeAndOpenVacancy(record.employeeHrId, {...}, actor)` with NO `access` param
(4th arg omitted) when a probation review ends in "terminate." This looks like a gap —
[[resignation-employee-scope-check]] (PR #689, 2026-07-02) added a generic `canSeeEmployee`
scope check inside `resignEmployeeAndOpenVacancy` that no-ops (via `systemAccessContext`)
whenever `access` is undefined, so probation-triggered terminations get zero enforcement
from that specific check.

**It must stay that way — do not "fix" it by threading `runProbationWorkflow`'s `access`
down through `applyDecisionSideEffects` into `resignEmployeeAndOpenVacancy`.**

**Why:** `runProbationWorkflow` already gates the whole action with `canReadProbationEmployee`
(`src/lib/probation/service.ts`) before it ever reaches termination, and that function is
*deliberately broader* than the generic `canSeeEmployee` (`src/lib/auth/permissions.ts`)
for exactly the roles that use this path:
- **Product Manager / Group Product Manager**: `canReadProbationEmployee` allows same-line
  (`isSameLine`/`sameWorkforceLine`) probation decisions. `canSeeEmployee`'s direct-report
  branch (`canSeeDirectReportsByRole`) does **not include PM/GPM at all** — so under the
  generic check, PM/GPM could only ever "see" themselves. Threading access through would
  make every PM/GPM probation termination throw `Forbidden`.
- **National Sales Manager**: `canReadProbationEmployee` allows the whole line; `canSeeEmployee`
  only allows one-hop direct reports.
- **Regional Manager**: `canReadProbationEmployee` walks the full manager hierarchy
  (`isInManagerHierarchy`, multi-level); `canSeeEmployee`'s direct-report check is single-hop
  only.

Passing `access` down would silently narrow an already-correct, already-enforced
domain-specific scope rule to a stricter generic one it was never designed to satisfy —
a real production regression (blocking legitimate terminations), not a security fix.

**How to apply:** if a future task asks to "close the scope-check gap" on the probation
termination path (or any other caller of `resignEmployeeAndOpenVacancy` that has its own
upstream domain-specific scope gate), first check whether that upstream gate is *broader*
than `canSeeEmployee` for any role that uses it. If so, leave the caller passing no `access`
(or extend the generic check itself to accept a caller-supplied override) rather than
threading the caller's `access` straight through. Caught this by cross-referencing
`canReadProbationEmployee` against `canSeeDirectReportsByRole`/`isDirectReport` before
implementing — almost shipped the regression on user request ("go ahead and fix") until the
role-by-role comparison surfaced it.
