import { strict as assert } from "node:assert";

import { isPlanItemVisibleToViewer } from "../src/lib/weekly-planning/calendar-service.ts";
import type { PlanningCalendarPlanItem } from "../src/lib/weekly-planning/calendar.ts";

/**
 * Coverage for the shared planning calendar's owner-eligibility gate
 * (isAllowedCalendarOwner, reached via isPlanItemVisibleToViewer). Cross-line
 * and cross-hierarchy viewer scoping (same-line, District-Manager-to-NSM,
 * Regional-Manager region bounds) was removed by owner decision 2026-07-19:
 * any viewer who already has weekly_plans:read access sees any
 * calendar-eligible plan. The only remaining question this function answers
 * is whether the plan's owner title is calendar-eligible at all.
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

export function runWeeklyPlanCalendarOwnerScopeTests() {
  // --- Title recognition (isAllowedCalendarOwner, via isPlanItemVisibleToViewer) ---

  const trainingManagerItem = planItem({ employeeHrId: "A-7", employeeJobTitle: "Training Manager", lineName: "Pedia" });
  assert.equal(
    isPlanItemVisibleToViewer(trainingManagerItem),
    true,
    "Training Manager item is recognized as an allowed owner via title",
  );

  const marketingManagerItem = planItem({ employeeHrId: "MM-1", employeeJobTitle: "Marketing Manager", lineName: "Pedia" });
  assert.equal(
    isPlanItemVisibleToViewer(marketingManagerItem),
    true,
    "Marketing Manager item is recognized as an allowed owner",
  );

  for (const title of ["District Manager", "District Sales Manager", "DSM"]) {
    const dmItem = planItem({ employeeHrId: "DM-1", employeeJobTitle: title, lineName: "Pedia" });
    assert.equal(
      isPlanItemVisibleToViewer(dmItem),
      true,
      `District Manager title variant "${title}" is recognized as an allowed owner`,
    );
  }

  const territoryManagerFullItem = planItem({ employeeHrId: "TER-1", employeeJobTitle: "Territory Manager", lineName: "Pedia" });
  assert.equal(
    isPlanItemVisibleToViewer(territoryManagerFullItem),
    true,
    "Territory Manager (full title) is still recognized — regression guard",
  );
  const territoryManagerAliasItem = planItem({ employeeHrId: "TER-2", employeeJobTitle: "TM", lineName: "Pedia" });
  assert.equal(
    isPlanItemVisibleToViewer(territoryManagerAliasItem),
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
    isPlanItemVisibleToViewer(unrecognizedItem),
    false,
    "an unrecognized job title (e.g. Medical Rep) is never an allowed owner, regardless of viewer",
  );

  const regionalManagerItem = planItem({ employeeHrId: "RM-1", employeeJobTitle: "Regional Manager", lineName: "Pedia" });
  assert.equal(
    isPlanItemVisibleToViewer(regionalManagerItem),
    false,
    "Regional Manager is not (yet) a calendar-eligible owner title — unchanged by the cross-line visibility change",
  );

  // --- Cross-line / cross-hierarchy visibility (owner decision 2026-07-19) ---
  // Once a plan's owner title is calendar-eligible, it is visible unconditionally —
  // there is no more per-viewer fencing by line, region, or reporting hierarchy.

  const headOfficeItem = planItem({ employeeHrId: "A-8", employeeJobTitle: "Training Manager", lineName: "Head Office" });
  assert.equal(
    isPlanItemVisibleToViewer(headOfficeItem),
    true,
    "Head Office line item stays visible (pre-existing bypass, now subsumed by the blanket rule)",
  );

  const crossLineItem = planItem({ employeeHrId: "PM-1", employeeJobTitle: "Product Manager", lineName: "Derma" });
  assert.equal(
    isPlanItemVisibleToViewer(crossLineItem),
    true,
    "a Derma-line Product Manager's plan is visible with no viewer/line comparison at all — the same-line fence is gone",
  );

  const noLineItem = planItem({ employeeHrId: "PM-2", employeeJobTitle: "Product Manager", lineName: null });
  assert.equal(
    isPlanItemVisibleToViewer(noLineItem),
    true,
    "a plan with no lineName on record is still visible — line no longer gates visibility at all",
  );

  const dmCrossHierarchyItem = planItem({ employeeHrId: "DM-9", employeeJobTitle: "District Manager", lineName: "Pedia" });
  assert.equal(
    isPlanItemVisibleToViewer(dmCrossHierarchyItem),
    true,
    "a District Manager's plan is visible unconditionally now — the NSM-hierarchy fence is gone",
  );
}
