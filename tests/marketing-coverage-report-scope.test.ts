import assert from "node:assert/strict";

import type { AccessContext, PhoenixRole } from "../src/lib/auth/permissions.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import {
  computeMarketingCoverageFilterOptions,
  resolveMarketingCoverageScope,
} from "../src/lib/marketing-requests/coverage-report-scope.ts";
import {
  collectRequestLineNames,
  lineRouteAdmitsRequest,
  resolveMarketingRoiScope,
} from "../src/lib/marketing-requests/roi-report-scope.ts";
import type { MarketingCoverageRequestIndexEntry } from "../src/lib/marketing-requests/roi-report-types.ts";

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

function access(role: PhoenixRole, hrId: string | null, scope: AccessContext["scope"]): AccessContext {
  return { hrId, loginId: hrId, role, scope, source: "session" };
}

// NSM → DM → Rep, all dept 1; plus a foreign-department rep who must stay hidden.
function directory(): EmployeeDirectoryRow[] {
  return [
    employee({ hrId: "B-157", fullName: "Line NSM", jobTitle: "National Sales Manager", managerHrId: null, lineName: "Anti Inf", departmentId: 1 }),
    employee({ hrId: "D-1", fullName: "District Mgr", jobTitle: "District Sales Manager", managerHrId: "B-157", lineName: "Anti Inf", departmentId: 1 }),
    employee({ hrId: "R-1", fullName: "Field Rep", jobTitle: "Medical Representative", managerHrId: "D-1", lineName: "Anti Inf", departmentId: 1 }),
    employee({ hrId: "F-9", fullName: "Foreign Rep", jobTitle: "Medical Representative", managerHrId: "D-9", lineName: "CNS", departmentId: 2 }),
    // A Finance Manager with no subordinates — nothing reports up to them.
    employee({ hrId: "FIN-1", fullName: "Finance Mgr", jobTitle: "Finance Manager", managerHrId: null, lineName: "Office", departmentId: 3 }),
  ];
}

function entry(overrides: Partial<MarketingCoverageRequestIndexEntry>): MarketingCoverageRequestIndexEntry {
  return {
    requestId: "req",
    requestCode: "REQ-0001",
    requesterHrId: "r-1",
    requesterName: "Field Rep",
    managerHrId: "d-1",
    status: "approved",
    requestTypeId: 1,
    requestTypeName: "Doctor Request",
    payDate: "2026-03-01",
    roiDurationMonths: 3,
    lineName: "Anti Inf",
    regionName: "Delta",
    areaName: "Cairo",
    requesterTier: "Medical Rep",
    dmHrId: "d-1",
    dmName: "District Mgr",
    nsmHrId: "b-157",
    nsmName: "Line NSM",
    rsmHrId: null,
    rsmName: null,
    approverRoleKeys: ["National Sales Manager"],
    distributorCodes: ["IS"],
    productCodes: ["GU001"],
    productNames: ["Guamusin"],
    pharmacyKeys: ["ph-1"],
    pharmacyNames: ["Pharmacy One"],
    hasRestrictedProduct: false,
    distributorWeights: [{ distributorCode: "IS", weight: 1 }],
    distributorNames: ["IS"],
    pharmacyIds: ["ph-1"],
    ...overrides,
  };
}

// The National Sales Manager's LINE route runs in the Coverage Report exactly as in ROI Tracking
// (owner, 2026-10-20: "He sees every campaign on his line, whoever ran it"). The Product, Group
// Product and Marketing Managers sit in the Marketing department, under the Marketing Manager, so
// the chain walk never reached them.
function lineRouteDirectory(): EmployeeDirectoryRow[] {
  return [
    employee({ hrId: "B-157", fullName: "Anti Inf NSM", jobTitle: "National Sales Manager", managerHrId: null, lineName: "Anti Inf", departmentId: 1 }),
    employee({ hrId: "RM-1", fullName: "Anti Inf RM", jobTitle: "Regional Manager", managerHrId: "B-157", lineName: "Anti Inf", departmentId: 1 }),
    employee({ hrId: "D-1", fullName: "District Mgr", jobTitle: "District Sales Manager", managerHrId: "RM-1", lineName: "Anti Inf", departmentId: 1 }),
    employee({ hrId: "R-1", fullName: "Field Rep", jobTitle: "Medical Representative", managerHrId: "D-1", lineName: "Anti Inf", departmentId: 1, areaId: 12 }),
    employee({ hrId: "N-2", fullName: "CNS NSM", jobTitle: "National Sales Manager", managerHrId: null, lineName: "CNS", departmentId: 2 }),
    employee({ hrId: "MM-1", fullName: "Marketing Mgr", jobTitle: "Marketing Manager", managerHrId: null, lineName: null, departmentId: 4, departmentName: "Marketing" }),
    employee({ hrId: "PM-1", fullName: "Anti Inf PM", jobTitle: "Product Manager", managerHrId: "MM-1", lineName: "Anti Inf", departmentId: 4, departmentName: "Marketing" }),
    employee({ hrId: "GPM-1", fullName: "Group PM", jobTitle: "Group Product Manager", managerHrId: "MM-1", lineName: "CNS", departmentId: 4, departmentName: "Marketing" }),
  ];
}

function runLineRouteTests() {
  const rows = lineRouteDirectory();
  const nsm = resolveMarketingCoverageScope(access("National Sales Manager", "B-157", "line"), rows);
  const cnsNsm = resolveMarketingCoverageScope(access("National Sales Manager", "N-2", "line"), rows);

  const pmOnHisLine = collectRequestLineNames("Anti Inf", ["Anti Inf"]);
  const pmOnOtherLine = collectRequestLineNames("CNS", ["CNS"]);
  const twoLineRequest = collectRequestLineNames("CNS", ["CNS", "Anti Inf"]);

  // -- An NSM sees a Product Manager's request on his line, in the Coverage Report too.
  assert.equal((nsm.visibleRequesterHrIds as Set<string>).has("pm-1"), false, "the chain walk still never reaches the Product Manager");
  assert.deepEqual(Array.from(nsm.visibleLineRouteNames), ["anti inf"], "the Coverage Report runs the NSM's line route");
  assert.equal(lineRouteAdmitsRequest(nsm, pmOnHisLine), true, "a Product Manager's campaign on his line is in his Coverage Report (owner, 2026-10-20)");

  // -- ...but NOT one on another line only.
  assert.equal(lineRouteAdmitsRequest(nsm, pmOnOtherLine), false, "a campaign on another line only stays out of his Coverage Report");
  assert.equal(lineRouteAdmitsRequest(nsm, collectRequestLineNames(null, [])), false, "an unknown line is never his");

  // -- A two-line request is in BOTH lines' NSMs' reports.
  assert.equal(lineRouteAdmitsRequest(nsm, twoLineRequest), true, "two-line request: Anti Inf NSM");
  assert.equal(lineRouteAdmitsRequest(cnsNsm, twoLineRequest), true, "two-line request: CNS NSM");

  // -- The two reports decide it identically: the same lines for the same NSM, override included,
  //    so a campaign is in both or in neither.
  {
    const override = { lineScopeOverride: ["Pedia"] };
    const roi = resolveMarketingRoiScope(access("National Sales Manager", "N-2", "line"), rows, override);
    const coverage = resolveMarketingCoverageScope(access("National Sales Manager", "N-2", "line"), rows, override);
    assert.deepEqual(
      Array.from(coverage.visibleLineRouteNames).sort(),
      Array.from(roi.visibleLineRouteNames).sort(),
      "ROI Tracking and the Coverage Report give the NSM the same line route",
    );
    assert.deepEqual(Array.from(coverage.visibleLineRouteNames).sort(), ["cns", "pedia"], "own line plus his override");
  }

  // -- District Manager / Medical Rep / Regional Manager / Product Manager: unchanged, override or not.
  {
    const override = { lineScopeOverride: ["Anti Inf", "CNS"] };
    const seats: Array<[PhoenixRole, string, AccessContext["scope"]]> = [
      ["District Manager", "D-1", "team"],
      ["Medical Rep", "R-1", "self"],
      ["Regional Manager", "RM-1", "team"],
      ["Product Manager", "PM-1", "line"],
    ];
    for (const [role, hrId, scopeName] of seats) {
      const before = resolveMarketingCoverageScope(access(role, hrId, scopeName), rows);
      const after = resolveMarketingCoverageScope(access(role, hrId, scopeName), rows, override);
      assert.equal(after.visibleLineRouteNames.size, 0, `${role} runs no line route in the Coverage Report`);
      assert.equal(lineRouteAdmitsRequest(after, pmOnHisLine), false, `${role} is not admitted by the line route`);
      assert.deepEqual(
        after.visibleRequesterHrIds === null ? null : Array.from(after.visibleRequesterHrIds).sort(),
        before.visibleRequesterHrIds === null ? null : Array.from(before.visibleRequesterHrIds).sort(),
        `${role}'s Coverage scope is exactly what it was`,
      );
      assert.equal(after.visibleAreaIds.size, 0, `${role}: the Coverage Report still runs no territory route`);
    }
  }

  // -- Restricted products stay masked, and a PM's campaign invents no DM / NSM option.
  {
    assert.equal(nsm.canRevealRestricted, false, "an NSM with a line route still may never reveal confidential products");
    const entries: MarketingCoverageRequestIndexEntry[] = [
      entry({ requestId: "own", dmHrId: "d-1", dmName: "District Mgr", nsmHrId: "b-157", nsmName: "Anti Inf NSM" }),
      entry({
        requestId: "pm",
        requesterHrId: "pm-1",
        requesterName: "Anti Inf PM",
        requesterTier: "Product Manager",
        dmHrId: null,
        dmName: null,
        nsmHrId: null,
        nsmName: null,
        rsmHrId: null,
        rsmName: null,
        hasRestrictedProduct: true,
      }),
    ];
    const { dimensions } = computeMarketingCoverageFilterOptions(nsm, entries);
    const byKey = (key: string) => {
      const found = dimensions.find((d) => d.key === key);
      assert.ok(found, `expected dimension ${key}`);
      return found!;
    };
    assert.equal(byKey("includeRestricted").render, false, "no include-confidential toggle for the NSM");
    assert.deepEqual(byKey("dm").options.map((o) => o.value), ["d-1"], "the PM's campaign invents no DM option");
    assert.deepEqual(byKey("nsm").options.map((o) => o.value), ["b-157"], "...no NSM option");
    assert.equal(byKey("nsm").autoApplied, null, "his lone NSM seat is not auto-applied over the PM's campaign");
  }
}

export function runMarketingCoverageReportScopeTests() {
  runLineRouteTests();
  const rows = directory();

  // ── CEO / Super Admin / SFE Manager / Marketing Manager: unrestricted here too.
  for (const role of ["CEO", "Super Admin", "SFE Manager", "Marketing Manager"] as PhoenixRole[]) {
    const scope = resolveMarketingCoverageScope(access(role, "V-1", "company"), rows);
    assert.equal(scope.isCompanyWide, true, `${role} must be company-wide in the coverage report`);
    assert.equal(scope.visibleRequesterHrIds, null);
  }

  // ── Finance Manager / Financial Advisor: company-wide here, as in ROI Tracking (owner,
  //    2026-10-09). Before, a Finance Manager with no subordinates resolved to himself alone
  //    and the real one opened a Coverage Report reading 0 of 52 requests. The ROLE decides,
  //    so even a "line"-scoped session is company-wide.
  for (const role of ["Finance Manager", "Financial Advisor"] as PhoenixRole[]) {
    const scope = resolveMarketingCoverageScope(access(role, "FIN-1", "line"), rows);
    assert.equal(scope.isCompanyWide, true, `${role} must be company-wide in the coverage report, as in ROI Tracking`);
    assert.equal(scope.visibleRequesterHrIds, null, `${role} must not be bounded to his own (empty) subtree`);
  }

  // ── NSM sees own line subtree (self + DM + rep), never the foreign-department rep.
  {
    const scope = resolveMarketingCoverageScope(access("National Sales Manager", "B-157", "line"), rows);
    assert.equal(scope.isCompanyWide, false);
    const visible = scope.visibleRequesterHrIds as Set<string>;
    assert.equal(visible.has("b-157"), true);
    assert.equal(visible.has("d-1"), true);
    assert.equal(visible.has("r-1"), true);
    assert.equal(visible.has("f-9"), false, "NSM must NOT see a foreign-department rep");
  }

  // ── Medical Rep is self-only (fail-closed baseline, unchanged from ROI Tracking).
  {
    const scope = resolveMarketingCoverageScope(access("Medical Rep", "R-1", "self"), rows);
    assert.equal(scope.selfOnly, true);
    const visible = scope.visibleRequesterHrIds as Set<string>;
    assert.equal(visible.size, 1);
    assert.equal(visible.has("r-1"), true);
  }

  // ── Product Manager: product-scoped, empty owned set → empty page, never a leak.
  {
    const scope = resolveMarketingCoverageScope(access("Product Manager", "P-1", "line"), rows);
    assert.equal(scope.visibleRequesterHrIds, null, "PM is not requester-scoped");
    assert.ok(scope.visibleProductCodes);
    assert.equal((scope.visibleProductCodes as Set<string>).size, 0, "no ownership wired yet → empty, fail-closed");
  }

  // ── computeMarketingCoverageFilterOptions carries the 2 new dimensions (area, requesterTier).
  {
    const ceoScope = resolveMarketingCoverageScope(access("CEO", "C-1", "company"), rows);
    const entries: MarketingCoverageRequestIndexEntry[] = [
      entry({ requestId: "a", areaName: "Cairo", requesterTier: "Medical Rep" }),
      entry({ requestId: "b", areaName: "Giza", requesterTier: "District Manager" }),
    ];
    const { dimensions } = computeMarketingCoverageFilterOptions(ceoScope, entries);
    const areaDim = dimensions.find((d) => d.key === "area");
    const tierDim = dimensions.find((d) => d.key === "requesterTier");
    assert.ok(areaDim, "area dimension must be present");
    assert.ok(tierDim, "requesterTier dimension must be present");
    assert.equal(areaDim!.render, true, "2 distinct areas → renders");
    assert.equal(tierDim!.render, true, "2 distinct tiers → renders");
  }
}
