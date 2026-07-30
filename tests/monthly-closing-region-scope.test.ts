import assert from "node:assert/strict";

import {
  applyRegionScope,
  canAccessPortalClosing,
  scopeMatrixToRegionNames,
  scopeMatrixToRegions,
} from "../src/lib/sales/monthly-closing-portal.ts";
import type { AccessContext, PhoenixRole } from "../src/lib/auth/permissions.ts";
import type {
  MonthlyClosingCell,
  MonthlyClosingMatrix,
} from "../src/lib/sales/monthly-distributor-import.ts";

// Region scoping for the monthly closing portal: a region-scoped manager (DM / RSM / MR) must see
// ONLY their region(s); the grand total is recomputed from the surviving regions and the
// whole-company (national-direct / company) totals are dropped.

function cell(salesValue: number, salesUnits: number): MonthlyClosingCell {
  return { salesUnits, salesValue, targetUnits: null, targetValue: null, achievement: null };
}

function region(code: string, name: string, c0: MonthlyClosingCell, c1: MonthlyClosingCell) {
  const cells = [c0, c1];
  const rowTotal = cell(c0.salesValue + c1.salesValue, c0.salesUnits + c1.salesUnits);
  return {
    regionCode: code,
    regionName: name,
    areas: [
      { kind: "area" as const, areaCode: `${code}-A`, areaName: `${name} Area`, regionCode: code, regionName: name, cells, rowTotal },
    ],
    subtotal: { kind: "regionSubtotal" as const, regionCode: code, regionName: name, cells, rowTotal },
  };
}

function buildMatrix(): MonthlyClosingMatrix {
  const ab = region("AB", "Alex-BHR", cell(100, 10), cell(200, 20));
  const ca = region("CA", "Cairo", cell(50, 5), cell(60, 6));
  const d1 = region("D1", "Delta (1)", cell(300, 30), cell(400, 40));
  const grandCells = [cell(450, 45), cell(660, 66)];
  return {
    availableLines: ["Pedia"],
    availablePeriods: ["2026-05"],
    columns: [
      { family: "F", productCode: "P1", productName: "Prod 1" },
      { family: "F", productCode: "P2", productName: "Prod 2" },
    ],
    line: "Pedia",
    period: "2026-05",
    regions: [ab, ca, d1],
    grandTotal: { kind: "grandTotal", cells: grandCells, rowTotal: cell(1110, 111) },
    directNational: { kind: "regionSubtotal", regionCode: "", regionName: "Direct", cells: [cell(0, 0), cell(0, 0)], rowTotal: cell(0, 0) },
    companyTotal: { kind: "grandTotal", cells: grandCells, rowTotal: cell(1110, 111) },
  };
}

export function runMonthlyClosingRegionScopeTests() {
  // ── Keep only the allowed regions (RSM-style multi-region: AB + D1, drop CA) ──
  const scoped = scopeMatrixToRegions(buildMatrix(), new Set(["AB", "D1"]));
  assert.deepEqual(scoped.regions.map((r) => r.regionCode), ["AB", "D1"], "drops out-of-scope region CA");

  // Grand total recomputed column-wise from the surviving regions' subtotals.
  assert.equal(scoped.grandTotal.cells[0].salesValue, 400, "col0 grand = AB(100)+D1(300)");
  assert.equal(scoped.grandTotal.cells[1].salesValue, 600, "col1 grand = AB(200)+D1(400)");
  assert.equal(scoped.grandTotal.cells[0].salesUnits, 40, "col0 units = 10+30");
  assert.equal(scoped.grandTotal.rowTotal.salesValue, 1000, "grand rowTotal = 400+600");

  // Whole-company / national-direct figures are dropped for a region-scoped manager.
  assert.equal(scoped.directNational, null, "national-direct dropped");
  assert.equal(scoped.companyTotal, null, "company total dropped");

  // ── Case-insensitive region matching (lower-case codes still match) ──
  const lower = scopeMatrixToRegions(buildMatrix(), new Set(["ca"]));
  assert.deepEqual(lower.regions.map((r) => r.regionCode), ["CA"], "lower-case 'ca' matches CA");
  assert.equal(lower.grandTotal.cells[0].salesValue, 50, "single-region grand = CA col0");

  // ── Empty allow-set => no regions (fail closed) ──
  const none = scopeMatrixToRegions(buildMatrix(), new Set());
  assert.equal(none.regions.length, 0, "empty allow-set keeps no regions");
  assert.equal(none.grandTotal.cells[0].salesValue, 0, "empty scope => zero grand total");

  // ── Name-based scoping (portal: the sales access-scope engine resolves viewer regions by NAME) ──
  // Allow tokens are canonical (lower-cased) region names, matched against the matrix's region names.
  const byName = scopeMatrixToRegionNames(buildMatrix(), new Set(["alex-bhr", "delta (1)"]));
  assert.deepEqual(byName.regions.map((r) => r.regionName), ["Alex-BHR", "Delta (1)"], "keeps regions matched by canonical name");
  assert.equal(byName.grandTotal.cells[0].salesValue, 400, "name-scoped grand col0 = AB(100)+D1(300)");
  assert.equal(byName.directNational, null, "national-direct dropped for name-scoped viewer");
  assert.equal(byName.companyTotal, null, "company total dropped for name-scoped viewer");

  const single = scopeMatrixToRegionNames(buildMatrix(), new Set(["cairo"]));
  assert.deepEqual(single.regions.map((r) => r.regionName), ["Cairo"], "canonical 'cairo' matches 'Cairo'");

  // ── Fail-open: a region name that maps to no matrix region (aggregate "Alexandria + Delta" RM) ──
  // scopeMatrixToRegionNames alone would blank the sheet…
  const blank = scopeMatrixToRegionNames(buildMatrix(), new Set(["alexandria + delta"]));
  assert.equal(blank.regions.length, 0, "unmapped aggregate region matches no matrix region");
  // …but applyRegionScope falls back to the whole line so the viewer never sees a blank sheet.
  const failOpen = applyRegionScope(buildMatrix(), new Set(["alexandria + delta"]));
  assert.equal(failOpen.regions.length, 3, "fail-open: unmapped region keeps the whole line");
  // A null scope (NSM / company) is an explicit whole-line pass-through.
  assert.equal(applyRegionScope(buildMatrix(), null).regions.length, 3, "null region scope = whole line");
  // A resolvable region still narrows.
  assert.deepEqual(
    applyRegionScope(buildMatrix(), new Set(["cairo"])).regions.map((r) => r.regionName),
    ["Cairo"],
    "matched region scope narrows to that region",
  );

  // ── Portal role gate (PORTAL_CLOSING_ROLES) — who may open the portal Monthly Closing page ──
  // Only reads access.role, so a minimal context is enough. "Manager" is the legacy District Manager
  // alias and must be allowed; CEO / Super Admin use the admin surface, not this portal page.
  const gate = (role: PhoenixRole) => canAccessPortalClosing({ role } as unknown as AccessContext);
  for (const allowed of [
    "District Manager",
    "Manager",
    "Regional Manager",
    "National Sales Manager",
    "Product Manager",
    "Group Product Manager",
  ] as PhoenixRole[]) {
    assert.equal(gate(allowed), true, `${allowed} may open the portal Monthly Closing`);
  }
  for (const denied of [
    "Medical Rep",
    "Marketing Manager",
    "Employee",
    "CEO",
    "Super Admin",
    "SFE Manager",
  ] as PhoenixRole[]) {
    assert.equal(gate(denied), false, `${denied} may NOT open the portal Monthly Closing`);
  }
}
