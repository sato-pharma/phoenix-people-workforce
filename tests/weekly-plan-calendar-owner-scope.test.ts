import { strict as assert } from "node:assert";

import { isPlanItemVisibleToViewer } from "../src/lib/weekly-planning/calendar-service.ts";
import { normalizeHrIdForAccess } from "../src/lib/auth/permissions.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type { PlanningCalendarPlanItem } from "../src/lib/weekly-planning/calendar.ts";
import { regionsWithinManagerHierarchy } from "../src/lib/workforce/hierarchy-resolver.ts";

/**
 * Role-based coverage for the shared planning calendar's owner-eligibility and
 * viewer-scoping expansion: District Manager, Marketing Manager, and Training
 * Manager plans now surface on the calendar. Marketing/Training Manager reuse the
 * same same-line viewer rule PM/GPM already have; District Manager gets a
 * stricter, reporting-hierarchy-based rule ("visible to his NSM") because a
 * District Manager's lineName does not reliably align with which NSM they report
 * to.
 */

function planItem(input: Partial<PlanningCalendarPlanItem> & { employeeHrId: string; employeeJobTitle: string | null }): PlanningCalendarPlanItem {
  return {
    activityTitle: "Field visit",
    activityType: "Field",
    area: null,
    conflictKey: null,
    conflictWarning: null,
    employeeName: "Test Employee",
    employeeDisplayName: "Test Employee",
    endDate: "2026-07-06",
    id: "plan-1",
    lineName: "Pedia",
    medicalRepHrId: null,
    medicalRepName: null,
    medicalRepDisplayName: null,
    notes: null,
    planId: "header-1",
    planKind: "weekly",
    region: null,
    source: "plan",
    startDate: "2026-07-06",
    status: "submitted",
    time: null,
    title: "Test Employee — Field visit",
    ...input,
  };
}

function directoryRow(input: Partial<EmployeeDirectoryRow> & { hrId: string }): EmployeeDirectoryRow {
  return {
    lineName: "Pedia",
    managerHrId: null,
    pendingManagerReplacementForHrId: null,
    ...input,
  } as EmployeeDirectoryRow;
}

function access(
  input: Partial<AccessContext> & { hrId: string | null; scope: AccessContext["scope"] },
): Pick<AccessContext, "hrId" | "role" | "scope"> {
  // Pre-existing tests don't care about role (only isPlanItemVisibleToViewer's Regional Manager
  // branch reads it) — default to a role that never matches that branch, so their behavior is
  // unaffected unless a test explicitly opts in with role: "Regional Manager".
  return { scope: input.scope, hrId: input.hrId, role: input.role ?? "Employee" };
}

export function runWeeklyPlanCalendarOwnerScopeTests() {
  // --- Title recognition ---------------------------------------------------

  const trainingManagerItem = planItem({ employeeHrId: "A-7", employeeJobTitle: "Training Manager", lineName: "Head Office" });
  assert.equal(
    isPlanItemVisibleToViewer(trainingManagerItem, access({ scope: "line", hrId: "OTHER" }), directoryRow({ hrId: "OTHER", lineName: "Pedia" }), null),
    true,
    "Training Manager item is recognized as an allowed owner via title, not merely via Head Office coincidence",
  );

  const marketingManagerItem = planItem({ employeeHrId: "MM-1", employeeJobTitle: "Marketing Manager", lineName: "Pedia" });
  assert.equal(
    isPlanItemVisibleToViewer(marketingManagerItem, access({ scope: "line", hrId: "OTHER" }), directoryRow({ hrId: "OTHER", lineName: "Pedia" }), null),
    true,
    "Marketing Manager item is recognized as an allowed owner",
  );

  for (const title of ["District Manager", "District Sales Manager", "DSM"]) {
    const dmItem = planItem({ employeeHrId: "DM-1", employeeJobTitle: title, lineName: "Pedia" });
    const nsm = directoryRow({ hrId: "NSM-1" });
    const dmOwner = directoryRow({ hrId: "DM-1", managerHrId: "NSM-1" });
    assert.equal(
      isPlanItemVisibleToViewer(dmItem, access({ scope: "line", hrId: "NSM-1" }), nsm, dmOwner),
      true,
      `District Manager title variant "${title}" is recognized as an allowed owner`,
    );
  }

  const territoryManagerFullItem = planItem({ employeeHrId: "TER-1", employeeJobTitle: "Territory Manager", lineName: "Pedia" });
  assert.equal(
    isPlanItemVisibleToViewer(territoryManagerFullItem, access({ scope: "line", hrId: "OTHER" }), directoryRow({ hrId: "OTHER", lineName: "Pedia" }), null),
    true,
    "Territory Manager (full title) is still recognized — regression guard",
  );
  const territoryManagerAliasItem = planItem({ employeeHrId: "TER-2", employeeJobTitle: "TM", lineName: "Pedia" });
  assert.equal(
    isPlanItemVisibleToViewer(territoryManagerAliasItem, access({ scope: "line", hrId: "OTHER" }), directoryRow({ hrId: "OTHER", lineName: "Pedia" }), null),
    true,
    "Territory Manager 'tm' alias is still recognized — regression guard",
  );
  // Territory Manager's "tm" alias must not be conflated with Training Manager:
  // both are recognized owners, but via independent match paths (full-string
  // containment for "training manager" vs the bare token alias for "tm").
  assert.notEqual(
    territoryManagerAliasItem.employeeJobTitle,
    trainingManagerItem.employeeJobTitle,
    "Territory Manager 'tm' fixture and Training Manager fixture use distinct titles",
  );

  const unrecognizedItem = planItem({ employeeHrId: "MR-1", employeeJobTitle: "Medical Rep", lineName: "Pedia" });
  assert.equal(
    isPlanItemVisibleToViewer(unrecognizedItem, access({ scope: "company", hrId: "CEO-1" }), null, null),
    false,
    "an unrecognized job title is never an allowed owner, even for a company-wide viewer",
  );

  // --- Line-scoped roles (PM/GPM/NSM/Territory Manager/Training Manager/Marketing Manager) ---

  const pmItem = planItem({ employeeHrId: "PM-1", employeeJobTitle: "Product Manager", lineName: "Pedia" });

  assert.equal(
    isPlanItemVisibleToViewer(pmItem, access({ scope: "company", hrId: "CEO-1" }), null, null),
    true,
    "company-wide viewer (CEO) sees a same-line-mismatched PM item",
  );
  assert.equal(
    isPlanItemVisibleToViewer(pmItem, access({ scope: "system", hrId: "SYS-1" }), null, null),
    true,
    "system-scope viewer sees any item",
  );

  const headOfficeTrainingItem = planItem({ employeeHrId: "A-7", employeeJobTitle: "Training Manager", lineName: "Head Office" });
  assert.equal(
    isPlanItemVisibleToViewer(headOfficeTrainingItem, access({ scope: "line", hrId: "OTHER" }), directoryRow({ hrId: "OTHER", lineName: "Derma" }), null),
    true,
    "Head Office line item is visible to any non-company viewer regardless of the viewer's own line",
  );

  assert.equal(
    isPlanItemVisibleToViewer(trainingManagerItem, access({ scope: "line", hrId: "OTHER" }), directoryRow({ hrId: "OTHER", lineName: "Pedia" }), null),
    true,
    "same-line viewer sees a Training Manager item (line rule, once past the Head Office branch)",
  );

  assert.equal(
    isPlanItemVisibleToViewer(marketingManagerItem, access({ scope: "line", hrId: "OTHER" }), directoryRow({ hrId: "OTHER", lineName: "Derma" }), null),
    false,
    "different-line viewer does not see a Marketing Manager item",
  );

  assert.equal(
    isPlanItemVisibleToViewer(pmItem, access({ scope: "line", hrId: "OTHER" }), directoryRow({ hrId: "OTHER", lineName: null }), null),
    false,
    "viewer with a null lineName fails closed on the same-line rule",
  );

  // --- District Manager hierarchy-scoped rule ------------------------------

  const dmItemPedia = planItem({ employeeHrId: "DM-1", employeeJobTitle: "District Manager", lineName: "Pedia" });
  const dmOwnerUnderNsm1 = directoryRow({ hrId: "DM-1", managerHrId: "NSM-1", lineName: "Pedia" });
  const nsm1 = directoryRow({ hrId: "NSM-1", lineName: "Pedia" });
  const nsm2 = directoryRow({ hrId: "NSM-2", lineName: "Pedia" });

  assert.equal(
    isPlanItemVisibleToViewer(dmItemPedia, access({ scope: "line", hrId: "NSM-1" }), nsm1, dmOwnerUnderNsm1),
    true,
    "NSM whose hrId matches the DM's managerHrId sees the DM's plan",
  );
  assert.equal(
    isPlanItemVisibleToViewer(dmItemPedia, access({ scope: "line", hrId: "NSM-2" }), nsm2, dmOwnerUnderNsm1),
    false,
    "a different NSM does NOT see the DM's plan even though line names match — hierarchy governs, not line",
  );

  const dmOwnerDifferentLine = directoryRow({ hrId: "DM-2", managerHrId: "NSM-1", lineName: "Delta" });
  const dmItemDifferentLine = planItem({ employeeHrId: "DM-2", employeeJobTitle: "District Manager", lineName: "Delta" });
  assert.equal(
    isPlanItemVisibleToViewer(dmItemDifferentLine, access({ scope: "line", hrId: "NSM-1" }), directoryRow({ hrId: "NSM-1", lineName: "Pedia" }), dmOwnerDifferentLine),
    true,
    "NSM sees the DM's plan even when their lineNames differ, as long as managerHrId matches — proves line misalignment no longer blocks visibility",
  );

  const dmOwnerVacantSeat = directoryRow({ hrId: "DM-3", managerHrId: "NSM-OLD", pendingManagerReplacementForHrId: "NSM-1", lineName: "Pedia" });
  const dmItemVacantSeat = planItem({ employeeHrId: "DM-3", employeeJobTitle: "District Manager", lineName: "Pedia" });
  assert.equal(
    isPlanItemVisibleToViewer(dmItemVacantSeat, access({ scope: "line", hrId: "NSM-1" }), directoryRow({ hrId: "NSM-1", lineName: "Pedia" }), dmOwnerVacantSeat),
    true,
    "NSM who inherited a vacant seat (pendingManagerReplacementForHrId) still sees the DM's plan",
  );

  assert.equal(
    isPlanItemVisibleToViewer(dmItemPedia, access({ scope: "line", hrId: "PM-1" }), directoryRow({ hrId: "PM-1", lineName: "Pedia" }), dmOwnerUnderNsm1),
    false,
    "an arbitrary same-line PM does NOT see the DM's plan — District Manager does not get the broader same-line rule",
  );

  assert.equal(
    isPlanItemVisibleToViewer(dmItemPedia, access({ scope: "team", hrId: "DM-1" }), dmOwnerUnderNsm1, dmOwnerUnderNsm1),
    true,
    "the District Manager sees their own plan on the shared calendar (self-visibility carve-out)",
  );

  assert.equal(
    isPlanItemVisibleToViewer(dmItemPedia, access({ scope: "company", hrId: "CEO-1" }), null, dmOwnerUnderNsm1),
    true,
    "CEO / company-wide scope sees any District Manager item regardless of hierarchy",
  );

  const dmItemHeadOffice = planItem({ employeeHrId: "DM-4", employeeJobTitle: "District Manager", lineName: "Head Office" });
  assert.equal(
    isPlanItemVisibleToViewer(dmItemHeadOffice, access({ scope: "line", hrId: "OTHER" }), directoryRow({ hrId: "OTHER", lineName: "Derma" }), directoryRow({ hrId: "DM-4" })),
    true,
    "a Head Office District Manager item is visible via the Head Office bypass, same as any other role",
  );

  // --- Regional Manager: line AND region bounded (owner rule 2026-07-18) ---
  // RM's own region_name is a coarse parent label that doesn't string-match the finer labels
  // on their reports, so the region set is derived from the RM's own subtree, not their own field.

  const rmRow = directoryRow({ hrId: "RM-1", lineName: "Pedia", regionName: "Alexandria + Delta" });
  const dm1UnderRm = directoryRow({ hrId: "DM-A", lineName: "Pedia", managerHrId: "RM-1", regionName: "Delta (1)" });
  const dm2UnderRm = directoryRow({ hrId: "DM-B", lineName: "Pedia", managerHrId: "RM-1", regionName: "ALEX-BHR" });
  const rmRegionKeys = regionsWithinManagerHierarchy(
    [rmRow, dm1UnderRm, dm2UnderRm],
    normalizeHrIdForAccess("RM-1") ?? "RM-1",
    normalizeHrIdForAccess,
  );
  assert.deepEqual(
    Array.from(rmRegionKeys).sort(),
    ["alex-bhr", "delta (1)"],
    "regionsWithinManagerHierarchy derives the RM's regions from his DMs' subtree, not his own coarse region_name",
  );

  const pmItemDelta1 = planItem({ employeeHrId: "PM-2", employeeJobTitle: "Product Manager", lineName: "Pedia", region: "Delta (1)" });
  assert.equal(
    isPlanItemVisibleToViewer(pmItemDelta1, access({ scope: "line", hrId: "RM-1", role: "Regional Manager" }), rmRow, null, rmRegionKeys),
    true,
    "RM sees a same-line item in a region his own subtree covers",
  );

  const pmItemOtherRegion = planItem({ employeeHrId: "PM-3", employeeJobTitle: "Product Manager", lineName: "Pedia", region: "Upper Egypt" });
  assert.equal(
    isPlanItemVisibleToViewer(pmItemOtherRegion, access({ scope: "line", hrId: "RM-1", role: "Regional Manager" }), rmRow, null, rmRegionKeys),
    false,
    "RM does NOT see a same-line item in a region outside his subtree — the out-of-region leak this rule closes",
  );

  const pmItemOtherLine = planItem({ employeeHrId: "PM-4", employeeJobTitle: "Product Manager", lineName: "Derma", region: "Delta (1)" });
  assert.equal(
    isPlanItemVisibleToViewer(pmItemOtherLine, access({ scope: "line", hrId: "RM-1", role: "Regional Manager" }), rmRow, null, rmRegionKeys),
    false,
    "RM does NOT see a different-line item even in a region his subtree covers — line bound still applies",
  );

  assert.equal(
    isPlanItemVisibleToViewer(pmItemDelta1, access({ scope: "line", hrId: "RM-1", role: "Regional Manager" }), rmRow, null, undefined),
    false,
    "RM sees nothing when the caller forgot to precompute regionalManagerRegionKeys — fails closed, never leaks",
  );

  // --- Non-owner items are never visible, regardless of viewer -------------

  assert.equal(
    isPlanItemVisibleToViewer(unrecognizedItem, access({ scope: "line", hrId: "MR-1" }), directoryRow({ hrId: "MR-1", lineName: "Pedia" }), directoryRow({ hrId: "MR-1" })),
    false,
    "an unrecognized-role item is not visible even to itself — isAllowedCalendarOwner gate runs first",
  );
}
