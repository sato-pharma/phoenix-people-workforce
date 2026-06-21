import assert from "node:assert/strict";

import type { AccessContext, PhoenixRole } from "../src/lib/auth/permissions.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import {
  computeMarketingFilterOptions,
  resolveMarketingRoiScope,
} from "../src/lib/marketing-requests/roi-report-scope.ts";
import type {
  MarketingRoiRequestIndexEntry,
  RoiFilterDimension,
  RoiFilterKey,
} from "../src/lib/marketing-requests/roi-report-types.ts";

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

// One NSM → one DM → one Rep, all in dept 1 (Anti Inf); plus a foreign-department
// rep that must never be visible to the NSM.
function directory(): EmployeeDirectoryRow[] {
  return [
    employee({ hrId: "B-157", fullName: "Line NSM", jobTitle: "National Sales Manager", managerHrId: null, lineName: "Anti Inf", departmentId: 1 }),
    employee({ hrId: "D-1", fullName: "District Mgr", jobTitle: "District Sales Manager", managerHrId: "B-157", lineName: "Anti Inf", departmentId: 1 }),
    employee({ hrId: "R-1", fullName: "Field Rep", jobTitle: "Medical Representative", managerHrId: "D-1", lineName: "Anti Inf", departmentId: 1 }),
    employee({ hrId: "F-9", fullName: "Foreign Rep", jobTitle: "Medical Representative", managerHrId: "D-9", lineName: "CNS", departmentId: 2 }),
  ];
}

function dim(dims: RoiFilterDimension[], key: RoiFilterKey): RoiFilterDimension {
  const found = dims.find((d) => d.key === key);
  assert.ok(found, `expected dimension ${key}`);
  return found as RoiFilterDimension;
}

function entry(overrides: Partial<MarketingRoiRequestIndexEntry>): MarketingRoiRequestIndexEntry {
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

export function runMarketingRoiReportScopeTests() {
  const rows = directory();

  // ── Company-wide oversight (CEO) sees everything; no requester/line/product limit.
  {
    const scope = resolveMarketingRoiScope(access("CEO", "C-1", "company"), rows);
    assert.equal(scope.isCompanyWide, true);
    assert.equal(scope.visibleRequesterHrIds, null);
    assert.equal(scope.visibleLineNames, null);
    assert.equal(scope.visibleProductCodes, null);
    assert.equal(scope.canRevealRestricted, true, "CEO may reveal confidential products");
  }

  // ── Super Admin also company-wide and may reveal.
  {
    const scope = resolveMarketingRoiScope(access("Super Admin", "A-1", "company"), rows);
    assert.equal(scope.isCompanyWide, true);
    assert.equal(scope.canRevealRestricted, true);
  }

  // ── NSM sees own line subtree (self + DM + rep), not the foreign-department rep.
  {
    const scope = resolveMarketingRoiScope(access("National Sales Manager", "B-157", "line"), rows);
    assert.equal(scope.isCompanyWide, false);
    assert.ok(scope.visibleRequesterHrIds);
    const visible = scope.visibleRequesterHrIds as Set<string>;
    assert.equal(visible.has("b-157"), true, "NSM sees own seat");
    assert.equal(visible.has("d-1"), true, "NSM sees their DM");
    assert.equal(visible.has("r-1"), true, "NSM sees their rep");
    assert.equal(visible.has("f-9"), false, "NSM must NOT see a foreign-department rep");
    assert.equal(scope.visibleDmHrIds.has("d-1"), true, "DM seat classified for the per-DM filter");
    assert.equal(scope.visibleNsmHrIds.has("b-157"), false, "own NSM seat excluded from the NSM filter");
    assert.equal(scope.canRevealRestricted, false, "NSM may never reveal confidential products");
  }

  // ── District Manager sees self + own reps, not the NSM above.
  {
    const scope = resolveMarketingRoiScope(access("District Manager", "D-1", "team"), rows);
    const visible = scope.visibleRequesterHrIds as Set<string>;
    assert.equal(visible.has("d-1"), true);
    assert.equal(visible.has("r-1"), true);
    assert.equal(visible.has("b-157"), false, "DM must not see the NSM's own requests");
    assert.equal(visible.has("f-9"), false);
  }

  // ── Medical Rep is self-only.
  {
    const scope = resolveMarketingRoiScope(access("Medical Rep", "R-1", "self"), rows);
    assert.equal(scope.selfOnly, true);
    const visible = scope.visibleRequesterHrIds as Set<string>;
    assert.equal(visible.size, 1);
    assert.equal(visible.has("r-1"), true);
  }

  // ── Product Manager is product-scoped (no requester limit), gated by owned codes.
  {
    const scope = resolveMarketingRoiScope(
      access("Product Manager", "P-1", "line"),
      rows,
      { ownedProductCodes: new Set(["GU001"]) },
    );
    assert.equal(scope.visibleRequesterHrIds, null, "PM is not requester-scoped");
    assert.ok(scope.visibleProductCodes);
    assert.equal((scope.visibleProductCodes as Set<string>).has("GU001"), true);
  }

  // ── Product Manager with no ownership wired yet → empty product set (empty page, never leak).
  {
    const scope = resolveMarketingRoiScope(access("Group Product Manager", "G-1", "line"), rows);
    assert.ok(scope.visibleProductCodes);
    assert.equal((scope.visibleProductCodes as Set<string>).size, 0);
  }

  // ── Filter options: "never show a dead filter".
  {
    const ceoScope = resolveMarketingRoiScope(access("CEO", "C-1", "company"), rows);
    const entries: MarketingRoiRequestIndexEntry[] = [
      entry({ requestId: "a", dmHrId: "d-1", dmName: "DM One", roiDurationMonths: 3, payDate: "2026-03-01", status: "approved" }),
      entry({ requestId: "b", dmHrId: "d-2", dmName: "DM Two", roiDurationMonths: 6, payDate: "2026-04-01", status: "pending_approval" }),
    ];
    const { dimensions, visibleRequestCount } = computeMarketingFilterOptions(ceoScope, entries);
    assert.equal(visibleRequestCount, 2);

    // DM has 2 live values → rendered, not auto-applied.
    const dmDim = dim(dimensions, "dm");
    assert.equal(dmDim.render, true);
    assert.equal(dmDim.autoApplied, null);
    assert.equal(dmDim.options.length, 2);

    // Line is identical across both → exactly 1 value → auto-applied + hidden.
    const lineDim = dim(dimensions, "line");
    assert.equal(lineDim.render, false);
    assert.deepEqual(lineDim.autoApplied, ["Anti Inf"]);

    // Status has 2 distinct values → rendered.
    assert.equal(dim(dimensions, "status").render, true);

    // Duration spans 3..6 → range rendered.
    const durDim = dim(dimensions, "duration");
    assert.equal(durDim.render, true);
    assert.equal(durDim.min, 3);
    assert.equal(durDim.max, 6);

    // Pay dates differ → range rendered.
    assert.equal(dim(dimensions, "payDate").render, true);
  }

  // ── Single-request set: every multiselect collapses (≤1 value) → none rendered.
  {
    const ceoScope = resolveMarketingRoiScope(access("CEO", "C-1", "company"), rows);
    const { dimensions } = computeMarketingFilterOptions(ceoScope, [entry({})]);
    for (const key of ["dm", "nsm", "line", "status", "requestType", "distributor", "product", "pharmacy"] as RoiFilterKey[]) {
      assert.equal(dim(dimensions, key).render, false, `single-request ${key} must not render`);
    }
    assert.equal(dim(dimensions, "duration").render, false, "single duration must not render");
    assert.equal(dim(dimensions, "payDate").render, false, "single pay date must not render");
  }

  // ── Confidential toggle: only when the viewer may reveal AND something is hidden.
  {
    const ceoScope = resolveMarketingRoiScope(access("CEO", "C-1", "company"), rows);
    const nsmScope = resolveMarketingRoiScope(access("National Sales Manager", "B-157", "line"), rows);
    const withRestricted = [entry({ requestId: "x", hasRestrictedProduct: true }), entry({ requestId: "y" })];

    assert.equal(
      dim(computeMarketingFilterOptions(ceoScope, withRestricted).dimensions, "includeRestricted").render,
      true,
      "CEO + restricted present → toggle renders",
    );
    assert.equal(
      dim(computeMarketingFilterOptions(ceoScope, [entry({})]).dimensions, "includeRestricted").render,
      false,
      "CEO + nothing restricted → toggle hidden",
    );
    assert.equal(
      dim(computeMarketingFilterOptions(nsmScope, withRestricted).dimensions, "includeRestricted").render,
      false,
      "NSM may never reveal → toggle hidden even when restricted present",
    );
  }

  // ── hr_id never leaks as a name: a name-keyed seat with no resolved fullName is
  //    HIDDEN from its dimension, never shown as its raw hr_id.
  {
    const ceoScope = resolveMarketingRoiScope(access("CEO", "C-1", "company"), rows);
    const named = entry({ requestId: "n", dmHrId: "d-1", dmName: "DM One" });
    const nameless = entry({ requestId: "m", dmHrId: "d-2", dmName: null });
    const dmDim = dim(computeMarketingFilterOptions(ceoScope, [named, nameless]).dimensions, "dm");
    assert.deepEqual(dmDim.options.map((o) => o.value), ["d-1"], "nameless seat must be hidden, not shown as its hr_id");
    assert.ok(
      !dmDim.options.some((o) => o.value === "d-2" || o.label === "d-2"),
      "raw hr_id must never appear as an option value-as-label",
    );
  }
}
