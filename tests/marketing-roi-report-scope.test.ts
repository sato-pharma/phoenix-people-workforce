import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AccessContext, PhoenixRole } from "../src/lib/auth/permissions.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import {
  collectRequestLineNames,
  computeMarketingFilterOptions,
  lineRouteAdmitsRequest,
  resolveMarketingRoiScope,
  territoryRouteAdmitsRequest,
} from "../src/lib/marketing-requests/roi-report-scope.ts";
import { resolveChainSeats } from "../src/lib/marketing-requests/roi-report-service.ts";
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

// The National Sales Manager's LINE route (owner, 2026-10-20: "He sees every campaign on his line,
// whoever ran it"). Two sales lines, each with its NSM, plus the Marketing department the Product,
// Group Product and Marketing Managers sit in - under the Marketing Manager, so OUTSIDE every NSM's
// chain. Department ids differ on purpose: that is what kept their campaigns away from the NSM.
function lineRouteDirectory(): EmployeeDirectoryRow[] {
  return [
    employee({ hrId: "B-157", fullName: "Anti Inf NSM", jobTitle: "National Sales Manager", managerHrId: null, lineName: "Anti Inf", departmentId: 1 }),
    employee({ hrId: "RM-1", fullName: "Anti Inf RM", jobTitle: "Regional Manager", managerHrId: "B-157", lineName: "Anti Inf", departmentId: 1 }),
    employee({ hrId: "D-1", fullName: "District Mgr", jobTitle: "District Sales Manager", managerHrId: "RM-1", lineName: "Anti Inf", departmentId: 1 }),
    employee({ hrId: "R-1", fullName: "Field Rep", jobTitle: "Medical Representative", managerHrId: "D-1", lineName: "Anti Inf", departmentId: 1, areaId: 12 }),
    employee({ hrId: "N-2", fullName: "CNS NSM", jobTitle: "National Sales Manager", managerHrId: null, lineName: "CNS", departmentId: 2 }),
    employee({ hrId: "D-2", fullName: "CNS DM", jobTitle: "District Sales Manager", managerHrId: "N-2", lineName: "CNS", departmentId: 2 }),
    employee({ hrId: "MM-1", fullName: "Marketing Mgr", jobTitle: "Marketing Manager", managerHrId: null, lineName: null, departmentId: 4, departmentName: "Marketing" }),
    employee({ hrId: "PM-1", fullName: "Anti Inf PM", jobTitle: "Product Manager", managerHrId: "MM-1", lineName: "Anti Inf", departmentId: 4, departmentName: "Marketing" }),
    employee({ hrId: "PM-2", fullName: "CNS PM", jobTitle: "Product Manager", managerHrId: "MM-1", lineName: "CNS", departmentId: 4, departmentName: "Marketing" }),
    employee({ hrId: "GPM-1", fullName: "Group PM", jobTitle: "Group Product Manager", managerHrId: "MM-1", lineName: "CNS", departmentId: 4, departmentName: "Marketing" }),
  ];
}

function runLineRouteTests() {
  const rows = lineRouteDirectory();
  const nsm = resolveMarketingRoiScope(access("National Sales Manager", "B-157", "line"), rows);
  const cnsNsm = resolveMarketingRoiScope(access("National Sales Manager", "N-2", "line"), rows);

  // Requests as the service reads their lines: the requester's seat line plus every promoted
  // product's line (collectRequestLineNames - the one builder every gate uses).
  const pmOnHisLine = collectRequestLineNames("Anti Inf", ["Anti Inf"]);
  const pmOnOtherLine = collectRequestLineNames("CNS", ["CNS"]);
  const twoLineRequest = collectRequestLineNames("CNS", ["CNS", "Anti Inf"]);
  const marketingManagerOnHisLine = collectRequestLineNames(null, ["Anti Inf"]);

  // -- The gap the owner ruled on: the requester route never reached the Marketing department.
  {
    const visible = nsm.visibleRequesterHrIds as Set<string>;
    assert.equal(visible.has("pm-1"), false, "the requester route still never reaches a Product Manager - the line route is a second door, not a wider chain");
    assert.equal(visible.has("d-1"), true, "his own chain is untouched");
    assert.deepEqual(Array.from(nsm.visibleLineRouteNames), ["anti inf"], "his line route is his own seat line, normalized");
  }

  // -- An NSM sees a Product Manager's request on his line (and the Marketing Manager's).
  assert.equal(lineRouteAdmitsRequest(nsm, pmOnHisLine), true, "a Product Manager's campaign on his line reaches the NSM (owner, 2026-10-20)");
  assert.equal(lineRouteAdmitsRequest(nsm, marketingManagerOnHisLine), true, "a lineless Marketing Manager's campaign on his products' line reaches him too");
  assert.equal(lineRouteAdmitsRequest(nsm, collectRequestLineNames(null, ["  aNTI iNF "])), true, "line matching is normalized");

  // -- He does NOT see one on another line only.
  assert.equal(lineRouteAdmitsRequest(nsm, pmOnOtherLine), false, "a campaign on another line only never reaches him");
  assert.equal(lineRouteAdmitsRequest(nsm, collectRequestLineNames(null, [])), false, "an unknown line is never his");
  assert.equal(lineRouteAdmitsRequest(nsm, [null, "  "]), false, "blank line names are not a match");

  // -- A two-line request is seen by BOTH lines' NSMs.
  assert.equal(lineRouteAdmitsRequest(nsm, twoLineRequest), true, "a two-line request is on the Anti Inf line");
  assert.equal(lineRouteAdmitsRequest(cnsNsm, twoLineRequest), true, "...and on the CNS line");
  assert.equal(lineRouteAdmitsRequest(cnsNsm, pmOnHisLine), false, "the CNS NSM does not see the Anti Inf PM's single-line campaign");

  // -- His line_scope_override ADDS lines to his own.
  {
    const withOverride = resolveMarketingRoiScope(access("National Sales Manager", "N-2", "line"), rows, {
      lineScopeOverride: ["Pedia", "  ", null],
    });
    assert.deepEqual(Array.from(withOverride.visibleLineRouteNames).sort(), ["cns", "pedia"], "own line plus the override, blanks dropped");
    assert.equal(lineRouteAdmitsRequest(withOverride, collectRequestLineNames("Pedia", ["Pedia"])), true, "an override line admits");
    assert.equal(lineRouteAdmitsRequest(cnsNsm, collectRequestLineNames("Pedia", ["Pedia"])), false, "without the override it does not");
  }

  // -- District Manager / Medical Rep / Regional Manager / Product Manager / CEO: unchanged. The
  //    route is inert for them even when an override is (wrongly) handed in.
  {
    const override = { lineScopeOverride: ["Anti Inf", "CNS", "Pedia"] };
    const seats: Array<[PhoenixRole, string, AccessContext["scope"]]> = [
      ["District Manager", "D-1", "team"],
      ["Medical Rep", "R-1", "self"],
      ["Regional Manager", "RM-1", "team"],
      ["Product Manager", "PM-1", "line"],
      ["Group Product Manager", "GPM-1", "line"],
      ["CEO", "C-1", "company"],
    ];
    for (const [role, hrId, scopeName] of seats) {
      const before = resolveMarketingRoiScope(access(role, hrId, scopeName), rows);
      const after = resolveMarketingRoiScope(access(role, hrId, scopeName), rows, override);
      assert.equal(after.visibleLineRouteNames.size, 0, `${role} runs no line route`);
      assert.equal(lineRouteAdmitsRequest(after, pmOnHisLine), false, `${role} is not admitted by the line route`);
      assert.deepEqual(
        after.visibleRequesterHrIds === null ? null : Array.from(after.visibleRequesterHrIds).sort(),
        before.visibleRequesterHrIds === null ? null : Array.from(before.visibleRequesterHrIds).sort(),
        `${role}'s requester route is exactly what it was`,
      );
      assert.deepEqual(Array.from(after.visibleAreaIds), Array.from(before.visibleAreaIds), `${role}'s territory areas are unchanged`);
      assert.deepEqual(Array.from(after.visibleAreaLineNames), Array.from(before.visibleAreaLineNames), `${role}'s territory lines are unchanged`);
    }
    const dm = resolveMarketingRoiScope(access("District Manager", "D-1", "team"), rows);
    assert.deepEqual(Array.from(dm.visibleRequesterHrIds as Set<string>).sort(), ["d-1", "r-1"], "a DM still sees exactly his own seat and his rep");
    const rep = resolveMarketingRoiScope(access("Medical Rep", "R-1", "self"), rows);
    assert.equal(territoryRouteAdmitsRequest(rep, 12, ["Anti Inf"]), true, "the rep keeps his territory route");
    assert.equal(territoryRouteAdmitsRequest(rep, 12, ["CNS"]), false, "...still bound to his own line");
  }

  // -- Restricted products stay masked: the route widens WHICH requests, never which names.
  {
    assert.equal(nsm.canRevealRestricted, false, "an NSM with a line route still may never reveal confidential products");
    const withRestricted = [
      entry({ requestId: "pm", requesterHrId: "pm-1", dmHrId: null, dmName: null, nsmHrId: null, nsmName: null, hasRestrictedProduct: true }),
      entry({ requestId: "own" }),
    ];
    const toggle = dim(computeMarketingFilterOptions(nsm, withRestricted).dimensions, "includeRestricted");
    assert.equal(toggle.render, false, "no include-confidential toggle for him, PM campaigns or not");
  }

  // -- A Product Manager's request never invents a DM / NSM / RSM option, and never lets his own
  //    lone NSM seat auto-apply over the campaigns that carry none.
  {
    const byHrId = new Map(rows.map((row) => [row.hrId.toLowerCase(), row] as const));
    const pmSeats = resolveChainSeats("pm-1", byHrId);
    assert.deepEqual(
      [pmSeats.dmHrId, pmSeats.nsmHrId, pmSeats.rsmHrId],
      [null, null, null],
      "a Product Manager's chain (PM to Marketing Manager) carries no sales seat",
    );
    const repSeats = resolveChainSeats("r-1", byHrId);
    assert.deepEqual([repSeats.dmHrId, repSeats.rsmHrId, repSeats.nsmHrId], ["d-1", "rm-1", "b-157"], "his own rep's chain still classifies");

    const entries = [
      entry({ requestId: "own", dmHrId: "d-1", dmName: "District Mgr", rsmHrId: "rm-1", rsmName: "Anti Inf RM", nsmHrId: "b-157", nsmName: "Anti Inf NSM" }),
      entry({
        requestId: "pm",
        requesterHrId: "pm-1",
        requesterName: "Anti Inf PM",
        dmHrId: pmSeats.dmHrId,
        dmName: pmSeats.dmName,
        rsmHrId: pmSeats.rsmHrId,
        rsmName: pmSeats.rsmName,
        nsmHrId: pmSeats.nsmHrId,
        nsmName: pmSeats.nsmName,
      }),
    ];
    const { dimensions, visibleRequestCount } = computeMarketingFilterOptions(nsm, entries);
    assert.equal(visibleRequestCount, 2);
    assert.deepEqual(dim(dimensions, "dm").options.map((o) => o.value), ["d-1"], "the PM's campaign invents no DM option");
    assert.deepEqual(dim(dimensions, "rsm").options.map((o) => o.value), ["rm-1"], "...no RM option");
    const nsmDim = dim(dimensions, "nsm");
    assert.deepEqual(nsmDim.options.map((o) => o.value), ["b-157"], "...no NSM option");
    assert.equal(nsmDim.autoApplied, null, "his own NSM seat is NOT auto-applied - that would filter the PM's campaign straight back out");
    assert.equal(dim(dimensions, "dm").autoApplied, null, "nor is the lone DM");
  }
}

// The gates themselves read the database, so they are pinned at the source: EVERY gate that admits
// a requester-scoped row must also run the line route, or the NSM sees a Product Manager's campaign
// in the list and is refused its View Sales (the 2026-09-30 territory-route defect, again).
function runLineRouteGatePins() {
  const roi = readFileSync("src/lib/marketing-requests/roi-report-service.ts", "utf8");
  assert.match(
    roi,
    /!requestIsInViewerArea\(request\.customerId, requestLineNames\) &&\s*!lineRouteAdmitsRequest\(scope, requestLineNames\)/,
    "the ROI report's gate admits by the NSM's line route",
  );
  assert.match(
    roi,
    /visible = lineRouteAdmitsRequest\(scope, requestLineNames\)/,
    "View Sales (and so the ROI Tracking export and roi-explain) admits by the same line route",
  );
  assert.match(
    roi,
    /if \(lineRouteAdmitsRequest\(scope, requestLineNames\)\) results\.push\(toResult\(row, requesterKey\)\)/,
    "the reverse pharmacy lookup admits by the same line route",
  );
  assert.equal(
    (roi.match(/lineScopeOverride: await resolveLineRouteOverride\(access\)/g) ?? []).length,
    2,
    "both ROI scopes (the report index and View Sales) read the NSM's line_scope_override",
  );
  const coverage = readFileSync("src/lib/marketing-requests/coverage-report-service.ts", "utf8");
  assert.match(
    coverage,
    /!lineRouteAdmitsRequest\(scope, collectRequestLineNames\(requesterRow\?\.lineName \?\? null, productLines\)\)/,
    "the Coverage Report's gate admits by the same line route, reading the request's lines the same way",
  );
  assert.match(
    coverage,
    /lineScopeOverride: await resolveLineRouteOverride\(access\)/,
    "the Coverage scope reads the NSM's line_scope_override too",
  );
  assert.match(
    coverage,
    /if \(scope\.visibleLineRouteNames\.size > 0\) return requests;/,
    "the Coverage fan-out never pre-narrows a line-route viewer by requester",
  );
}

export function runMarketingRoiReportScopeTests() {
  runLineRouteTests();
  runLineRouteGatePins();
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

  // ── REGRESSION: a lone value present on only a SUBSET must NOT auto-apply ──────────
  // The org's single Regional Manager appears in one request's chain; the other request
  // has no RM. Previously this auto-applied that RM in autoAppliedByDimension for every
  // viewer (and applying it would have excluded the RM-less request). Now: one value but
  // not universal → not auto-applied, not rendered.
  {
    const ceoScope = resolveMarketingRoiScope(access("CEO", "C-1", "company"), rows);
    const mixed: MarketingRoiRequestIndexEntry[] = [
      entry({ requestId: "withRm", rsmHrId: "pd-0001", rsmName: "Solo RM" }),
      entry({ requestId: "noRm", rsmHrId: null, rsmName: null }),
    ];
    const rsmDim = dim(computeMarketingFilterOptions(ceoScope, mixed).dimensions, "rsm");
    assert.equal(rsmDim.options.length, 1, "only one RM value exists across the requests");
    assert.equal(rsmDim.autoApplied, null, "a lone RM covering only a subset is NOT auto-applied");
    assert.equal(rsmDim.render, false, "single-option dimension still does not render");

    // contrast: a universal lone RM (present on every request) still auto-applies.
    const universal = [
      entry({ requestId: "u1", rsmHrId: "pd-0001", rsmName: "Solo RM" }),
      entry({ requestId: "u2", rsmHrId: "pd-0001", rsmName: "Solo RM" }),
    ];
    assert.deepEqual(
      dim(computeMarketingFilterOptions(ceoScope, universal).dimensions, "rsm").autoApplied,
      ["pd-0001"],
      "a universal lone RM still auto-applies",
    );
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
