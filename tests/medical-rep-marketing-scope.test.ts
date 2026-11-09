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
import {
  resolveMarketingRoiScope,
  territoryRouteAdmitsRequest,
} from "../src/lib/marketing-requests/roi-report-scope.ts";
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
 *      them, which in practice is their DM's spend on their patch; and
 *   5. that route is bounded by his area AND his LINE (owner, 2026-09-30). An area is shared by
 *      every line's rep standing on it, so the area alone showed the Pedia rep on Gharbia 2 the CNS
 *      District Manager's campaign — see testTheTerritoryRouteIsAreaAndLine at the foot of the file.
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
    "the sibling rep's area must NOT be in scope - his own area is one half of the bound (his own LINE is the other)",
  );
  assert.equal(
    repScope.visibleRequesterHrIds?.has("d-1") ?? false,
    false,
    "the territory route must not become a back door to the requester route - scope still runs downward",
  );

  // A District Manager runs the same route over the district since 2026-11-09 (owner: "all shortcuts we built
  // for Hany, build it for all district managers, but every one based on his scope"): the areas of the reps under
  // them, never their own seat's, plus their own line — both halves or neither (tests/district-team-reports.test.ts).
  const dmScope = resolveMarketingRoiScope(access("District Manager", "D-1", "line"), rows);
  assert.deepEqual(Array.from(dmScope.visibleAreaIds).sort(), [11, 12], "a District Manager's area route is their reps' areas");
  assert.equal(
    dmScope.visibleAreaLineNames.size > 0,
    dmScope.visibleAreaIds.size > 0,
    "the line half of the territory route must be empty wherever the area half is, and filled wherever it is filled",
  );
}

/**
 * 6. THE TERRITORY ROUTE IS AREA **AND** LINE — owner ruling, 2026-09-30, on the ROI Tracker:
 * "the Gharbiya 2 rep, line Pedia, is seeing the request of Gharbiya 2 line CNS ... it doesn't mean
 * that he is the same area that he sees. He must see his line. This is a fatal mistake."
 *
 * An area is NOT per line, which is the whole trap. Live `public.areas` rows carry `line_id` NULL —
 * the per-line rows (ids 76/77) were deactivated — so "Gharbia 2 (Mahalla)" is ONE row, id 1104,
 * held at the same time by the Pedia rep, the CNS rep and the Anti Infective rep on that patch. The
 * 2026-09-18 route matched on `area_id` alone, so it read as "requests in his area" and behaved as
 * "requests in his area on ANY line".
 *
 * Measured on production 2026-09-30, before the fix: the route admitted 82 rep×request pairs and
 * **46 of them were another line's campaign**, reaching 28 of the 72 active reps. The owner's own
 * case is the fixture below — B-158 (Pedia, area 1104) opened his tracker and the ONLY row on it
 * was MKT-REQ-20260831-393D40C7, raised by B-120, the CNS District Manager.
 *
 * The named seats and area id are production's, so this test reads as the incident it pins.
 */
function testTheTerritoryRouteIsAreaAndLine() {
  const GHARBIA_2 = 1104; // public.areas, code D15, line_id NULL — shared by every line's rep.
  const rows = [
    employee({ areaId: null, fullName: "CNS District Manager", hrId: "B-120", jobTitle: "District Sales Manager", lineName: "CNS" }),
    employee({ areaId: null, fullName: "Pedia District Manager", hrId: "B-154", jobTitle: "District Sales Manager", lineName: "Pedia" }),
    employee({ areaId: GHARBIA_2, fullName: "Pedia rep on Gharbia 2", hrId: "B-158", lineName: "Pedia", managerHrId: "B-154" }),
    employee({ areaId: GHARBIA_2, fullName: "CNS rep on Gharbia 2", hrId: "B-128", lineName: "CNS", managerHrId: "B-120" }),
  ];

  const pediaRep = resolveMarketingRoiScope(access("Medical Rep", "B-158", "self"), rows);
  assert.deepEqual(
    Array.from(pediaRep.visibleAreaIds),
    [GHARBIA_2],
    "the Pedia rep's area half must still be his own area",
  );
  assert.deepEqual(
    Array.from(pediaRep.visibleAreaLineNames),
    ["pedia"],
    "the LINE half must carry the rep's own line, lower-cased - without it the route is area-only and leaks",
  );

  // THE HEADLINE. The CNS District Manager's campaign on this very area must NOT reach the Pedia rep.
  assert.equal(
    territoryRouteAdmitsRequest(pediaRep, GHARBIA_2, ["CNS"]),
    false,
    "FATAL: a CNS request on the Pedia rep's own area must NOT reach him - same area is not same line (owner, 2026-09-30)",
  );
  // ...and his own line's spend on his own patch still must.
  assert.equal(
    territoryRouteAdmitsRequest(pediaRep, GHARBIA_2, ["Pedia"]),
    true,
    "his own DM's Pedia spend on his own area must still reach him - that is what the route is FOR",
  );

  // Symmetric: the CNS rep on the same area is refused the Pedia campaign and keeps the CNS one.
  const cnsRep = resolveMarketingRoiScope(access("Medical Rep", "B-128", "self"), rows);
  assert.equal(
    territoryRouteAdmitsRequest(cnsRep, GHARBIA_2, ["Pedia"]),
    false,
    "the leak must be closed in BOTH directions - the CNS rep must not see the Pedia campaign either",
  );
  assert.equal(territoryRouteAdmitsRequest(cnsRep, GHARBIA_2, ["CNS"]), true, "the CNS rep keeps his own line");

  // A sibling area on his OWN line is still out: the 2026-09-18 bound did not loosen.
  assert.equal(
    territoryRouteAdmitsRequest(pediaRep, 1103, ["Pedia"]),
    false,
    "Gharbia 1 is another rep's patch - narrowing by line must not widen by area",
  );

  // Case and padding must not be a way through: the comparison is normalized inside the decision.
  assert.equal(territoryRouteAdmitsRequest(pediaRep, GHARBIA_2, ["  pEdIa "]), true, "line matching is normalized");

  // A request spanning two lines is on BOTH, so either line's rep on that patch sees it.
  assert.equal(
    territoryRouteAdmitsRequest(pediaRep, GHARBIA_2, ["CNS", "Pedia"]),
    true,
    "a two-line request is partly his line and targets his patch",
  );

  // An UNKNOWABLE line is refused, never waved through. The requester route is untouched, so nothing
  // the hierarchy already granted him is lost by this being strict.
  assert.equal(
    territoryRouteAdmitsRequest(pediaRep, GHARBIA_2, []),
    false,
    "a request whose line cannot be established is not 'his line'",
  );
  assert.equal(territoryRouteAdmitsRequest(pediaRep, GHARBIA_2, [null, "  "]), false, "blank line names are not a match");
  assert.equal(territoryRouteAdmitsRequest(pediaRep, null, ["Pedia"]), false, "a target with no area has no territory route");

  // A rep whose master record carries no line runs NO territory route at all — refusing beats
  // falling back to area-only, which is the bug itself.
  const linelessRows = [employee({ areaId: GHARBIA_2, fullName: "Rep with no line", hrId: "R-9", lineName: null })];
  const linelessRep = resolveMarketingRoiScope(access("Medical Rep", "R-9", "self"), linelessRows);
  assert.equal(linelessRep.visibleAreaIds.size, 0, "no line means no territory route - never an area-only fallback");
  assert.equal(linelessRep.visibleAreaLineNames.size, 0, "both halves drop together");
  assert.equal(
    territoryRouteAdmitsRequest(linelessRep, GHARBIA_2, ["Pedia"]),
    false,
    "a lineless rep is admitted nothing by the territory route",
  );
}

export async function runMedicalRepMarketingScopeTests() {
  testTheRepLosesRequestsAndInbox();
  testTheRepKeepsCustomerValidation();
  testTheRepKeepsTheRoiTracker();
  testTheBoundaryIsServerSide();
  testTheRepSeesTheirOwnAreaInTheRoiTracker();
  testTheTerritoryRouteIsAreaAndLine();
}
