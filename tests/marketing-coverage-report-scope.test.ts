import assert from "node:assert/strict";

import type { AccessContext, PhoenixRole } from "../src/lib/auth/permissions.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import {
  computeMarketingCoverageFilterOptions,
  resolveMarketingCoverageScope,
} from "../src/lib/marketing-requests/coverage-report-scope.ts";
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
    ...overrides,
  };
}

export function runMarketingCoverageReportScopeTests() {
  const rows = directory();

  // ── CEO / Super Admin / SFE Manager / Marketing Manager: unrestricted here too.
  for (const role of ["CEO", "Super Admin", "SFE Manager", "Marketing Manager"] as PhoenixRole[]) {
    const scope = resolveMarketingCoverageScope(access(role, "V-1", "company"), rows);
    assert.equal(scope.isCompanyWide, true, `${role} must be company-wide in the coverage report`);
    assert.equal(scope.visibleRequesterHrIds, null);
  }

  // ── KEY DIVERGENCE from ROI Tracking: Finance Manager / Financial Advisor are
  //    SCOPED here, not company-wide. With no subordinates, a Finance Manager
  //    resolves to seeing only themselves (fail-closed self-only), never everyone.
  for (const role of ["Finance Manager", "Financial Advisor"] as PhoenixRole[]) {
    const scope = resolveMarketingCoverageScope(access(role, "FIN-1", "line"), rows);
    assert.equal(scope.isCompanyWide, false, `${role} must NOT be company-wide in the coverage report`);
    assert.ok(scope.visibleRequesterHrIds, `${role} must have a bounded visible-requester set`);
    const visible = scope.visibleRequesterHrIds as Set<string>;
    assert.equal(visible.has("fin-1"), true, `${role} sees their own requests`);
    assert.equal(visible.has("r-1"), false, `${role} must NOT see an unrelated rep's requests`);
    assert.equal(visible.has("b-157"), false, `${role} must NOT see an unrelated NSM's requests`);
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
