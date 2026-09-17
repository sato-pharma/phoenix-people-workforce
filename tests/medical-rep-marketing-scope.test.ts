import assert from "node:assert/strict";

import { employeePortalNavigationSections } from "../src/config/system-navigation.ts";
import { createAccessContext, type AccessContext, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import {
  canUseEmployeePortalMarketingRequests,
  canUseEmployeePortalMarketingRoiTracking,
  canUseEmployeePortalMarketingValidation,
  resolveEmployeePortalNavVisibility,
} from "../src/lib/employee-portal/navigation.ts";
import { resolveMarketingRoiScope } from "../src/lib/marketing-requests/roi-report-scope.ts";
import {
  assertMarketingApprovalInboxAccess,
  assertMarketingDraftWorkspaceAccess,
  assertMarketingRequestAccess,
  assertMarketingRequestCreationAccess,
} from "../src/lib/marketing-requests/service.ts";

/**
 * The Medical Rep's marketing surface, as the owner redrew it on 2026-09-18: hide the drafts
 * workspace and the Approval Inbox, keep Customer Validation so the rep can validate customers for
 * their District Manager, and keep the ROI Tracker so they can follow the return on the requests
 * their manager raised in their area.
 *
 * Four things have to hold together, and before this change each was one predicate away from the
 * others — Customer Validation and the drafts workspace shared ONE role list, so narrowing that
 * list would have shut the capture screen on the very people who do the capturing:
 *
 *   1. the rep cannot reach the drafts workspace or the Approval Inbox — in the sidebar, in the
 *      nav catalog, AND server-side, which is the only one of the three that is a boundary;
 *   2. the rep KEEPS Customer Validation, which is how their District Manager gets a validated
 *      customer to raise a request against (the hierarchy route in canSeeMarketingCustomer);
 *   3. the rep KEEPS the ROI Tracker; and
 *   4. that tracker is not blank for them — a rep raises nothing now, so the requester route alone
 *      would show an empty page. The territory route puts their own area's requests in front of
 *      them, which in practice is their DM's spend on their patch.
 *
 * Every other seat must be untouched. The District Manager below is the control.
 */

const MARKETING_SEATS: readonly PhoenixRole[] = [
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
  "SFE Manager",
  "CEO",
  "Super Admin",
];

function employee(overrides: Partial<EmployeeDirectoryRow>): EmployeeDirectoryRow {
  return {
    areaId: null,
    areaName: null,
    departmentId: 1,
    departmentName: "Sales",
    employmentStatus: "active",
    fullName: "Employee",
    hireDate: null,
    hrId: "X-0",
    jobTitle: "Medical Representative",
    lineId: 1,
    lineName: "Anti Inf",
    managerHrId: null,
    organogramVisible: true,
    positionTitle: null,
    regionName: null,
    teamId: null,
    teamName: null,
    ...overrides,
  } as EmployeeDirectoryRow;
}

function access(role: PhoenixRole, hrId: string, scope: AccessContext["scope"]): AccessContext {
  return { hrId, loginId: hrId, role, scope, source: "session" };
}

function marketingCatalogItems() {
  const section = employeePortalNavigationSections.find((entry) => entry.id === "employee-marketing-requests");
  assert.ok(section, "the portal nav catalog must still carry the employee-marketing-requests section");
  return section.items;
}

function catalogRoles(href: string): readonly string[] {
  const item = marketingCatalogItems().find((entry) => entry.href === href);
  assert.ok(item, `${href} must still be in the employee-portal nav catalog`);
  return (item.roles ?? []) as readonly string[];
}

// 1. The two surfaces the rep lost.
function testTheRepLosesRequestsAndInbox() {
  assert.equal(
    canUseEmployeePortalMarketingRequests("Medical Rep"),
    false,
    "a Medical Rep must not reach the marketing drafts workspace or the Approval Inbox",
  );

  const rep = resolveEmployeePortalNavVisibility("Medical Rep");
  assert.equal(rep.showMarketingRequestsTab, false, "Marketing Requests must be gone from the rep's sidebar");
  assert.equal(rep.showMarketingInboxTab, false, "the Approval Inbox must be gone from the rep's sidebar");

  for (const href of ["/employee-portals/marketing-requests", "/employee-portals/marketing-requests/inbox"]) {
    assert.equal(
      catalogRoles(href).includes("Medical Rep"),
      false,
      `${href} must not list Medical Rep in the nav catalog - the command palette reads this list`,
    );
  }

  for (const role of MARKETING_SEATS) {
    assert.equal(
      canUseEmployeePortalMarketingRequests(role),
      true,
      `${role} must keep the marketing drafts workspace`,
    );
  }
}

// 2. Customer Validation survives - the whole point of splitting the predicate.
function testTheRepKeepsCustomerValidation() {
  assert.equal(
    canUseEmployeePortalMarketingValidation("Medical Rep"),
    true,
    "Customer Validation is the rep's field-capture screen and must stay open to them",
  );
  assert.equal(
    resolveEmployeePortalNavVisibility("Medical Rep").showMarketingValidationTab,
    true,
    "Customer Validation must still be drawn in the rep's sidebar",
  );
  assert.equal(
    catalogRoles("/employee-portals/marketing-requests/validation").includes("Medical Rep"),
    true,
    "Customer Validation must still list Medical Rep in the nav catalog",
  );

  // The service gate behind the capture screen still admits a rep. This is the one that would have
  // closed had marketingCreatorRoles been narrowed instead of a new set being added beside it.
  assert.doesNotThrow(() =>
    assertMarketingRequestAccess(createAccessContext({ hrId: "R-1", role: "Medical Rep" })),
  );
}

// 3. The ROI Tracker survives.
function testTheRepKeepsTheRoiTracker() {
  assert.equal(
    canUseEmployeePortalMarketingRoiTracking("Medical Rep"),
    true,
    "the rep keeps the ROI Tracker (owner, 2026-09-18)",
  );
  assert.equal(
    resolveEmployeePortalNavVisibility("Medical Rep").showMarketingRoiTrackingTab,
    true,
    "the ROI Tracker flag must stay on for a Medical Rep",
  );
  assert.equal(
    catalogRoles("/employee-portals/roi-tracker").includes("Medical Rep"),
    true,
    "the ROI Tracker must still list Medical Rep in the nav catalog",
  );
}

// 4. The boundary is server-side. A hidden link is not a closed door.
function testTheBoundaryIsServerSide() {
  const rep = createAccessContext({ hrId: "R-1", role: "Medical Rep" });
  const districtManager = createAccessContext({ hrId: "D-1", role: "District Manager" });

  assert.throws(
    () => assertMarketingRequestCreationAccess(rep),
    /cannot raise a marketing request/i,
    "a rep posting a draft straight to the API must be refused",
  );
  assert.throws(
    () => assertMarketingDraftWorkspaceAccess(rep),
    /cannot use marketing requests/i,
    "a rep must not be able to read the drafts workspace payload",
  );
  assert.throws(
    () => assertMarketingApprovalInboxAccess(rep),
    /cannot open the marketing approval inbox/i,
    "a rep must not be able to read the approver inbox payload",
  );

  for (const gate of [
    assertMarketingRequestCreationAccess,
    assertMarketingDraftWorkspaceAccess,
    assertMarketingApprovalInboxAccess,
  ]) {
    assert.doesNotThrow(
      () => gate(districtManager),
      "the District Manager keeps every marketing request surface",
    );
  }

  // The inbox gate is a NEGATIVE test on purpose: that queue is actor-scoped, so a seat holding no
  // rung has always seen an empty list rather than a refusal. Only the rep's door closed.
  for (const role of ["Finance Manager", "Financial Advisor", "HR Advisory", "Training Manager"] as const) {
    assert.doesNotThrow(
      () => assertMarketingApprovalInboxAccess(createAccessContext({ hrId: "H-1", role })),
      `${role} must keep exactly the approver-inbox answer it had before 2026-09-18`,
    );
  }
}

// 5. The territory route that makes the rep's ROI Tracker answer anything at all.
function testTheRepSeesTheirOwnAreaInTheRoiTracker() {
  const rows = [
    employee({
      areaId: 11,
      fullName: "District Mgr",
      hrId: "D-1",
      jobTitle: "District Sales Manager",
      managerHrId: null,
    }),
    employee({ areaId: 11, fullName: "Own Rep", hrId: "R-1", managerHrId: "D-1" }),
    employee({ areaId: 12, fullName: "Sibling Rep", hrId: "R-2", managerHrId: "D-1" }),
  ];

  const repScope = resolveMarketingRoiScope(access("Medical Rep", "R-1", "self"), rows);
  assert.deepEqual(
    Array.from(repScope.visibleAreaIds),
    [11],
    "a Medical Rep's ROI scope must carry their OWN area - that is how their DM's spend on their patch reaches them",
  );
  assert.equal(
    repScope.visibleAreaIds.has(12),
    false,
    "the sibling rep's area must NOT be in scope - 'in his area' is the whole bound",
  );
  assert.equal(
    repScope.visibleRequesterHrIds?.has("d-1") ?? false,
    false,
    "the territory route must not become a back door to the requester route - scope still runs downward",
  );

  // Nobody else gets an area route: a DM already reaches their whole subtree through the requester
  // route, which is wider than one area.
  const dmScope = resolveMarketingRoiScope(access("District Manager", "D-1", "line"), rows);
  assert.equal(dmScope.visibleAreaIds.size, 0, "only the Medical Rep runs the territory route");
}

export async function runMedicalRepMarketingScopeTests() {
  testTheRepLosesRequestsAndInbox();
  testTheRepKeepsCustomerValidation();
  testTheRepKeepsTheRoiTracker();
  testTheBoundaryIsServerSide();
  testTheRepSeesTheirOwnAreaInTheRoiTracker();
}
