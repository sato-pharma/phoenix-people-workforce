import assert from "node:assert/strict";

import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import {
  isPlanOwnerWithinViewerManagementChain,
  resolvePlanViewerScope,
} from "../src/lib/weekly-planning/plan-visibility.ts";

// Only hrId / managerHrId / pendingManagerReplacementForHrId matter to the code under test
// (role/line/title are never read from the directory row — COMPANY_WIDE_PLAN_VIEWER_ROLES
// checks access.role, not the row), so the fixture stays minimal.
function row(
  hrId: string,
  managerHrId: string | null,
  pendingManagerReplacementForHrId: string | null = null,
): EmployeeDirectoryRow {
  return { hrId, managerHrId, pendingManagerReplacementForHrId } as EmployeeDirectoryRow;
}

export function runWeeklyPlanVisibilityTests() {
  // -- 1. The reported case: a 4-level chain proves both the 2-hop skip-level case
  //    (the actual bug report — a manager's manager) and a 3-hop skip-skip-level case
  //    in one fixture, so a full recursive walk is confirmed, not "one extra hop."
  //    MKM-1 (Marketing Manager) -> GPM-1 (Group Product Manager) -> PM-1 (Product
  //    Manager) -> JR-1 (a report of PM-1).
  const chain: EmployeeDirectoryRow[] = [
    row("MKM-1", null),
    row("GPM-1", "MKM-1"),
    row("PM-1", "GPM-1"),
    row("JR-1", "PM-1"),
  ];
  const mktMgrScope = resolvePlanViewerScope({ hrId: "MKM-1", role: "Marketing Manager" }, chain);
  assert.equal(
    isPlanOwnerWithinViewerManagementChain("PM-1", mktMgrScope),
    true,
    "the reported bug: a manager's manager (MKM-1) must see a skip-level report's (PM-1) plan",
  );
  assert.equal(
    isPlanOwnerWithinViewerManagementChain("JR-1", mktMgrScope),
    true,
    "a full recursive walk, not one extra hop: MKM-1 also sees the 3rd-level report JR-1",
  );
  assert.equal(
    isPlanOwnerWithinViewerManagementChain("GPM-1", mktMgrScope),
    true,
    "the existing direct-report case (GPM-1) still works under the new scope",
  );
  assert.equal(
    isPlanOwnerWithinViewerManagementChain("MKM-1", mktMgrScope),
    false,
    "a viewer is never their own management-chain report (self-visibility is handled separately by canViewPlan)",
  );

  // -- 2. An unrelated peer (no reporting relationship to the viewer at all) must
  //    NOT be visible — the walk must not leak across unrelated branches.
  const unrelated: EmployeeDirectoryRow[] = [...chain, row("CEO-1", null), row("UNREL-1", "CEO-1")];
  const mktMgrScopeWithUnrelated = resolvePlanViewerScope({ hrId: "MKM-1", role: "Marketing Manager" }, unrelated);
  assert.equal(
    isPlanOwnerWithinViewerManagementChain("UNREL-1", mktMgrScopeWithUnrelated),
    false,
    "an employee outside the viewer's chain must stay invisible (no cross-branch leak)",
  );

  // -- 3. Seat continuity: after a manager resigns, the resignation trigger reassigns
  //    their reports' managerHrId UPWARD and stamps pendingManagerReplacementForHrId
  //    with the departed manager's own hr_id (see hierarchy-resolver.ts) — mirrors the
  //    pattern in tests/workforce-hierarchy-continuity.test.ts.
  const departed = "DEPARTED-MGR-1";
  const activeUpwardManager = "ACTIVE-MGR-1";
  const orphanedReport = row("ORPHAN-1", activeUpwardManager, departed);
  const seatFixture: EmployeeDirectoryRow[] = [row(activeUpwardManager, null), orphanedReport];
  const activeManagerScope = resolvePlanViewerScope({ hrId: activeUpwardManager, role: "Product Manager" }, seatFixture);
  assert.equal(
    isPlanOwnerWithinViewerManagementChain("ORPHAN-1", activeManagerScope),
    true,
    "the manager the report was reassigned UP to sees it via the live managerHrId edge",
  );
  const departedManagerScope = resolvePlanViewerScope({ hrId: departed, role: "Product Manager" }, seatFixture);
  assert.equal(
    isPlanOwnerWithinViewerManagementChain("ORPHAN-1", departedManagerScope),
    true,
    "the departed manager's own hr_id still resolves the report via the seat-continuity marker",
  );

  // -- 4. Training Manager / HR Advisory: company-wide, independent of any
  //    chain relationship (matches the existing Calendar-tab grant for these roles).
  const noChainScope = resolvePlanViewerScope({ hrId: "TM-1", role: "Training Manager" }, unrelated);
  assert.equal(
    isPlanOwnerWithinViewerManagementChain("UNREL-1", noChainScope),
    true,
    "Training Manager sees a completely unrelated employee's plan — company-wide, not chain-based",
  );
  const hrScope = resolvePlanViewerScope({ hrId: "TA-1", role: "HR Advisory" }, unrelated);
  assert.equal(
    isPlanOwnerWithinViewerManagementChain("UNREL-1", hrScope),
    true,
    "HR Advisory sees a completely unrelated employee's plan — company-wide, not chain-based",
  );

  // -- 5. A role with no reports gains nothing extra: hierarchyReportHrIds is empty
  //    and every other employee stays invisible via this branch. JR-1 is the true
  //    leaf of `chain` (nobody reports to it) — PM-1 is NOT a valid stand-in here,
  //    since PM-1 is JR-1's own manager and legitimately has 1 report in this fixture.
  const leafScope = resolvePlanViewerScope({ hrId: "JR-1", role: "Product Manager" }, chain);
  assert.equal(leafScope.hierarchyReportHrIds.size, 0, "an employee with no reports has an empty chain set");
  assert.equal(
    isPlanOwnerWithinViewerManagementChain("PM-1", leafScope),
    false,
    "a leaf employee gains no new visibility from this branch",
  );
  assert.equal(
    isPlanOwnerWithinViewerManagementChain("GPM-1", leafScope),
    false,
    "a leaf employee does not see their own manager's manager's plan via this branch either",
  );
}
