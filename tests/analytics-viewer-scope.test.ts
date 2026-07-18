import assert from "node:assert/strict";

import { getSalesScope, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import { computeSalesAccessScope } from "../src/lib/sales/access-scope.ts";
import {
  computeAnalyticsViewerScope,
  intersectDimension,
  scopeAnalyticsFilters,
  type AnalyticsViewerScope,
} from "../src/lib/analytics/scope.ts";

// A canonical-region-name → region-code map, as resolveAnalyticsViewerScope builds from the master.
const REGION_MAP = new Map<string, string>([
  ["cairo", "CAI"],
  ["giza", "GIZ"],
  ["alexandria", "ALX"],
]);

// End-to-end: role → real SalesAccessScope → AnalyticsViewerScope (the scope the loaders will use).
function analyticsScopeForRole(
  role: PhoenixRole,
  opts?: { line?: string | null; region?: string | null },
): AnalyticsViewerScope {
  const sales = computeSalesAccessScope({
    role,
    businessScope: getSalesScope({ role }),
    viewerLineName: opts?.line ?? null,
    viewerRegionName: opts?.region ?? null,
    includeRestricted: false,
  });
  return computeAnalyticsViewerScope(sales, REGION_MAP);
}

export function runAnalyticsViewerScopeTests() {
  // ── intersectDimension ──────────────────────────────────────────────────────
  assert.deepEqual(intersectDimension(["Pedia"], null), { values: ["Pedia"], empty: false }, "null allowed = no restriction");
  assert.deepEqual(intersectDimension([], new Set()), { values: [], empty: true }, "empty allowed = fail-closed nothing");
  assert.deepEqual(intersectDimension([], new Set(["Pedia", "CNS"])), { values: ["Pedia", "CNS"], empty: false }, "no selection = all allowed");
  assert.deepEqual(intersectDimension(["Pedia", "CNS"], new Set(["Pedia"])), { values: ["Pedia"], empty: false }, "selection ∩ allowed");
  assert.deepEqual(intersectDimension(["Anti infective"], new Set(["Pedia"])), { values: [], empty: true }, "disjoint selection → empty");
  // case-insensitive
  assert.deepEqual(intersectDimension(["pedia"], new Set(["Pedia"])), { values: ["pedia"], empty: false }, "case-insensitive match");

  // ── scopeAnalyticsFilters ───────────────────────────────────────────────────
  const allNull: AnalyticsViewerScope = { canViewAllSales: true, allowedLineNames: null, allowedRegionCodes: null, allowedProductCodes: null };
  const passthrough = scopeAnalyticsFilters({ lines: ["Pedia"], regions: ["CAI"], products: ["P1"] }, allNull);
  assert.equal(passthrough.empty, false);
  assert.deepEqual(passthrough.filters.lines, ["Pedia"], "company scope = untouched filters");

  const pmScope: AnalyticsViewerScope = { canViewAllSales: false, allowedLineNames: new Set(["Pedia"]), allowedRegionCodes: null, allowedProductCodes: null };
  const pmNoSelection = scopeAnalyticsFilters({ lines: [], regions: [], products: [] }, pmScope);
  assert.deepEqual(pmNoSelection.filters.lines, ["Pedia"], "line-scoped viewer, no selection → scoped to their line");
  assert.equal(pmNoSelection.empty, false);
  const pmForeignLine = scopeAnalyticsFilters({ lines: ["Anti infective"], regions: [], products: [] }, pmScope);
  assert.equal(pmForeignLine.empty, true, "line-scoped viewer selecting a foreign line → empty (fail-closed)");

  const emptyLineScope: AnalyticsViewerScope = { canViewAllSales: false, allowedLineNames: new Set(), allowedRegionCodes: null, allowedProductCodes: null };
  assert.equal(scopeAnalyticsFilters({ lines: [] }, emptyLineScope).empty, true, "empty allowed line set (unknown line) → fail-closed empty");

  // ── computeAnalyticsViewerScope: region NAME → CODE ─────────────────────────
  const regionScoped = computeAnalyticsViewerScope(
    { canViewAllSales: false, allowedLineNames: new Set(["Pedia"]), allowedRegionNames: new Set(["cairo"]), allowedProductCodes: null },
    REGION_MAP,
  );
  assert.deepEqual([...(regionScoped.allowedRegionCodes ?? [])], ["CAI"], "region name resolved to code");
  const unknownRegion = computeAnalyticsViewerScope(
    { canViewAllSales: false, allowedLineNames: null, allowedRegionNames: new Set(["atlantis"]), allowedProductCodes: null },
    REGION_MAP,
  );
  assert.equal(unknownRegion.allowedRegionCodes?.size, 0, "unresolvable region → empty set (fail-closed), never null");

  // ── Per-role end-to-end scope (the real model) ──────────────────────────────
  // Company-wide roles see everything (all sets null).
  for (const role of ["CEO", "Super Admin", "SFE Manager"] as const) {
    const s = analyticsScopeForRole(role, { line: "Pedia", region: "Cairo" });
    assert.equal(s.canViewAllSales, true, `${role} = company-wide`);
    assert.equal(s.allowedLineNames, null, `${role} no line restriction`);
    assert.equal(s.allowedRegionCodes, null, `${role} no region restriction`);
  }

  // Line-scoped roles: bounded to their own line, no region restriction.
  for (const role of ["National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager"] as const) {
    const s = analyticsScopeForRole(role, { line: "Pedia", region: "Cairo" });
    assert.equal(s.canViewAllSales, false, `${role} not company-wide`);
    assert.ok(s.allowedLineNames && s.allowedLineNames.has("Pedia"), `${role} bounded to its line`);
    assert.equal(s.allowedRegionCodes, null, `${role} (LINE) has no region restriction`);
  }

  // Regional Manager (HIERARCHY): own line + own region.
  const rm = analyticsScopeForRole("Regional Manager", { line: "Pedia", region: "Cairo" });
  assert.ok(rm.allowedLineNames?.has("Pedia"), "RM bounded to its line");
  assert.deepEqual([...(rm.allowedRegionCodes ?? [])], ["CAI"], "RM bounded to its region");

  // District Manager (TEAM) + Medical Rep (SELF): own line + own region.
  const dm = analyticsScopeForRole("District Manager", { line: "CNS", region: "Giza" });
  assert.ok(dm.allowedLineNames?.has("CNS") && [...(dm.allowedRegionCodes ?? [])].includes("GIZ"), "DM bounded to line+region");
  const mr = analyticsScopeForRole("Medical Rep", { line: "Pedia", region: "Alexandria" });
  assert.ok(mr.allowedLineNames?.has("Pedia") && [...(mr.allowedRegionCodes ?? [])].includes("ALX"), "Med Rep bounded to line+region");

  // Missing line → fail-closed empty line set (sees nothing until a line is known).
  const pmNoLine = analyticsScopeForRole("Product Manager", { line: null, region: null });
  assert.equal(pmNoLine.allowedLineNames?.size, 0, "line-scoped role with unknown line → empty (fail-closed)");
}
