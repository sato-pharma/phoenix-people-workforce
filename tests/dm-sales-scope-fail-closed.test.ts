import assert from "node:assert/strict";

import type { SalesAccessScope } from "../src/lib/sales/access-scope.ts";
import {
  applyRegionScope,
  isAreaBoundMatrixEmpty,
  PORTAL_CLOSING_AREAS_EMPTY_MESSAGE,
  scopeMatrixToGeographyNoFallback,
} from "../src/lib/sales/monthly-closing-portal.ts";
import type { MonthlyClosingCell, MonthlyClosingMatrix } from "../src/lib/sales/monthly-distributor-import.ts";
import {
  assertTargetsAreaInBound,
  filterAchievementForScope,
  targetsBoundFromSalesScope,
  TARGETS_TERRITORY_UNRESOLVED_MESSAGE,
} from "../src/lib/sales/portal-targets.ts";
import {
  __resetSeatAreaScopeCacheForTests,
  __setSeatAreaInputsLoaderForTests,
  resolveSeatAreaScope,
} from "../src/lib/sales/seat-area-scope.ts";
import { vsTargetBoundFromSalesScope } from "../src/lib/sales/vs-target-scope.ts";
import { createAccessContext } from "../src/lib/auth/permissions.ts";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";

// ─────────────────────────────────────────────────────────────────────────────
// District Manager sales-scope leaks (2026-10-26). Three holes, one rule: a District / Regional
// Manager's reach is his organogram seat's AREAS — never his region, never his whole line.
//
//   1. The Targets drill-down checked the area but not the LINE, and area codes repeat across lines
//      (UE1 is a CNS area and an Anti-infective area, each with its own manager).
//   2. The portal Monthly Closing fell back from unmatched seat areas to the region, then to the
//      whole line matrix.
//   3. A District Manager whose seat gave no areas (unseated, unmapped, or an organogram read that
//      failed) was bounded to his whole line on Targets and Sales vs Target; and the read failure was
//      cached for a minute.
// ─────────────────────────────────────────────────────────────────────────────

function cell(salesValue: number): MonthlyClosingCell {
  return { salesUnits: salesValue, salesValue, targetUnits: null, targetValue: null, achievement: null };
}

function areaRow(areaCode: string, regionCode: string, regionName: string, value: number) {
  return {
    areaCode,
    areaName: `${areaCode} name`,
    cells: [cell(value)],
    kind: "area" as const,
    regionCode,
    regionName,
    rowTotal: cell(value),
  };
}

/** CNS Upper Egypt: Amgad's UE1 + UE2, and a sibling district's UE9; plus Cairo. */
function cnsMatrix(): MonthlyClosingMatrix {
  const ue = [areaRow("UE1", "UE", "Upper Egypt", 100), areaRow("UE2", "UE", "Upper Egypt", 200), areaRow("UE9", "UE", "Upper Egypt", 900)];
  const ca = [areaRow("CA1", "CA", "Cairo", 4000)];
  return {
    columns: [{ productCode: "P1", productName: "Prod 1" }],
    regions: [
      { areas: ue, regionCode: "UE", regionName: "Upper Egypt", subtotal: { kind: "subtotal", cells: [cell(1200)], regionCode: "UE", regionName: "Upper Egypt", rowTotal: cell(1200) } },
      { areas: ca, regionCode: "CA", regionName: "Cairo", subtotal: { kind: "subtotal", cells: [cell(4000)], regionCode: "CA", regionName: "Cairo", rowTotal: cell(4000) } },
    ],
    grandTotal: { kind: "grandTotal", cells: [cell(5200)], rowTotal: cell(5200) },
    directNational: null,
    companyTotal: null,
  } as unknown as MonthlyClosingMatrix;
}

const areaCodesOf = (matrix: MonthlyClosingMatrix) =>
  matrix.regions.flatMap((region) => region.areas.map((area) => area.areaCode)).sort();

function salesScope(overrides: Partial<SalesAccessScope>): SalesAccessScope {
  return {
    role: "District Manager",
    businessScope: "TEAM",
    canViewAllSales: false,
    canViewRestrictedProducts: false,
    includeRestrictedProductsAllowed: false,
    restrictedIncluded: false,
    excludedProductCodes: [],
    allowedLineNames: new Set(["CNS"]),
    allowedRegionNames: new Set(["upper egypt"]),
    allowedAreaNames: null,
    allowedAreaCodes: null,
    allowedAreaFactRegionCodes: null,
    allowedProductCodes: null,
    ...overrides,
  } as SalesAccessScope;
}

function achievementRow(lineCode: string, areaCode: string): AchievementRow {
  return { lineCode, areaCode, regionCode: "UE", productCode: "P1" } as unknown as AchievementRow;
}

function forbidden(run: () => void, message: RegExp, label: string) {
  assert.throws(run, (error: unknown) => error instanceof Error && message.test(error.message), label);
}

export async function runDmSalesScopeFailClosedTests() {
  // ── 1. Targets drill-down: the LINE is checked with the area ──────────────
  const amgad = targetsBoundFromSalesScope(
    salesScope({ allowedAreaCodes: new Set(["UE1", "UE2"]), allowedAreaFactRegionCodes: new Set(["UE"]) }),
  );
  assert.equal(amgad.canViewAllTargets, false);
  assert.deepEqual([...(amgad.lineCodes ?? [])], ["cns"], "a CNS District Manager is bound to the cns line");
  assert.doesNotThrow(() => assertTargetsAreaInBound(amgad, "UE1", "CNS"), "his own area on his own line still opens");
  forbidden(
    () => assertTargetsAreaInBound(amgad, "UE1", "Anti infective"),
    /line is outside your territory/,
    "🔴 his own area code on ANOTHER line is refused — area codes repeat across lines",
  );
  forbidden(() => assertTargetsAreaInBound(amgad, "UE1", "not-a-line"), /line is outside your territory/, "an unknown line is refused");
  forbidden(() => assertTargetsAreaInBound(amgad, "UE9", "CNS"), /area is outside your territory/, "a sibling's area is still refused");
  const company = targetsBoundFromSalesScope(salesScope({ role: "CEO", businessScope: "COMPANY", canViewAllSales: true }));
  assert.doesNotThrow(() => assertTargetsAreaInBound(company, "UE9", "Pedia"), "canViewAllTargets still passes any area on any line");

  // ── 2. Monthly Closing: seat areas never fall back to the region or the line ──
  const own = applyRegionScope(cnsMatrix(), null, new Set(["UE1", "UE2"]));
  assert.deepEqual(areaCodesOf(own), ["UE1", "UE2"], "his own areas still show");
  assert.equal(own.grandTotal.rowTotal.salesValue, 300, "and total only his 100 + 200");

  // Null region (a District Manager with no region label) whose areas match no row this month.
  const nullRegionMiss = applyRegionScope(cnsMatrix(), null, new Set(["UE7"]));
  assert.equal(nullRegionMiss.regions.length, 0, "🔴 null region + unmatched seat areas = no rows, never the whole line");
  assert.equal(nullRegionMiss.grandTotal.rowTotal.salesValue, 0, "and a zero total, not the line's 5,200");
  assert.equal(isAreaBoundMatrixEmpty(nullRegionMiss, new Set(["UE7"])), true, "the page is told to say so");

  // A region label AND seat areas that match nothing: no rows — never his region.
  const regionMiss = applyRegionScope(cnsMatrix(), new Set(["upper egypt"]), new Set(["UE7"]));
  assert.equal(regionMiss.regions.length, 0, "🔴 unmatched seat areas never fall back to the Upper Egypt region");

  // An EMPTY seat area set with no region label: nothing.
  assert.equal(applyRegionScope(cnsMatrix(), null, new Set()).regions.length, 0, "an empty area set is no rows");

  // The Regional Manager aggregate-label fallback survives — region-level scope only.
  const aggregateLabel = applyRegionScope(cnsMatrix(), new Set(["alexandria + delta"]), null);
  assert.equal(aggregateLabel.regions.length, 2, "a region-level label that matches nothing keeps the line-locked matrix");
  assert.equal(isAreaBoundMatrixEmpty(aggregateLabel, null), false, "and a region-level viewer gets no area-empty message");
  assert.equal(applyRegionScope(cnsMatrix(), new Set(), null).regions.length, 0, "the engine's empty region set stays closed");
  assert.deepEqual(areaCodesOf(applyRegionScope(cnsMatrix(), new Set(["cairo"]), null)), ["CA1"], "a matching region narrows");

  // The Performance Review uses the same helper, so the two screens cannot drift apart.
  assert.equal(scopeMatrixToGeographyNoFallback(cnsMatrix(), null, new Set(["UE7"])).regions.length, 0);
  assert.equal(scopeMatrixToGeographyNoFallback(cnsMatrix(), new Set(["alexandria + delta"]), null).regions.length, 0);
  assert.equal(scopeMatrixToGeographyNoFallback(cnsMatrix(), null, null).regions.length, 2, "line viewer: the whole line-locked matrix");
  assert.match(PORTAL_CLOSING_AREAS_EMPTY_MESSAGE, /Your areas have no rows/);

  // ── 3. No seat areas never widens to the line ──────────────────────────────
  const rows = [achievementRow("cns", "UE1"), achievementRow("cns", "UE9"), achievementRow("cns", "CA1")];
  for (const [role, businessScope] of [["District Manager", "TEAM"], ["Regional Manager", "HIERARCHY"]] as const) {
    const unseated = salesScope({ role, businessScope, allowedAreaCodes: null });
    const targets = targetsBoundFromSalesScope(unseated);
    assert.equal(targets.territoryUnresolved, true, `${role} with no seat areas is flagged unresolved`);
    assert.equal(targets.areaCodes?.size, 0, `🔴 ${role} with no seat areas gets an EMPTY area bound, never null (the line)`);
    assert.deepEqual(filterAchievementForScope(rows, targets), [], `🔴 ${role} with no seat areas sees no targets`);
    forbidden(() => assertTargetsAreaInBound(targets, "UE1", "CNS"), /area is outside your territory/, `${role} drill-down refused`);

    const ctx = createAccessContext({ role, hrId: "B-118", source: "dev-header" });
    assert.deepEqual(vsTargetBoundFromSalesScope(unseated, ctx), { kind: "none" }, `🔴 ${role} Sales vs Target is none, not the line`);
  }
  assert.match(TARGETS_TERRITORY_UNRESOLVED_MESSAGE, /organogram/);

  // A seated District Manager is unchanged.
  const seated = salesScope({ allowedAreaCodes: new Set(["UE1"]), allowedAreaFactRegionCodes: new Set(["UE"]) });
  assert.equal(targetsBoundFromSalesScope(seated).territoryUnresolved, undefined);
  assert.deepEqual(filterAchievementForScope(rows, targetsBoundFromSalesScope(seated)).map((row) => row.areaCode), ["UE1"]);
  const seatedVs = vsTargetBoundFromSalesScope(seated, createAccessContext({ role: "District Manager", hrId: "B-118", source: "dev-header" }));
  assert.equal(seatedVs.kind, "areas");

  // National Sales Manager and Product Manager keep their line.
  for (const role of ["National Sales Manager", "Product Manager"] as const) {
    const lineScope = salesScope({ role, businessScope: "LINE", allowedRegionNames: null });
    const targets = targetsBoundFromSalesScope(lineScope);
    assert.equal(targets.territoryUnresolved, undefined, `${role} is not flagged`);
    assert.equal(targets.areaCodes, null, `${role} keeps the line bound`);
    assert.equal(filterAchievementForScope(rows, targets).length, 3, `${role} sees the whole line`);
    const vs = vsTargetBoundFromSalesScope(lineScope, createAccessContext({ role, hrId: "B-1", source: "dev-header" }));
    assert.equal(vs.kind, "line", `${role} Sales vs Target keeps the line`);
  }

  // ── 3b. An organogram read error is never cached ───────────────────────────
  const dmCtx = createAccessContext({ role: "District Manager", hrId: "B-118", source: "dev-header" });
  let reads = 0;
  let failNext = true;
  __resetSeatAreaScopeCacheForTests();
  __setSeatAreaInputsLoaderForTests(async () => {
    reads += 1;
    if (failNext) throw new Error("organogram read failed");
    return {
      seats: [{ seatId: "SEAT-CNS-DM-UE", seatTier: "DM", lineCode: "cns", path: ["SEAT-CNS-NSM", "SEAT-CNS-DM-UE"], occupantHrId: "B-118" }],
      lineAreas: [{ lineCode: "cns", areaCode: "UE1", dmSeatId: "SEAT-CNS-DM-UE" }],
      factRegionByAreaCode: new Map([["UE1", "UE"]]),
    };
  });
  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.equal(await resolveSeatAreaScope(dmCtx), null, "a failed read answers null");
    failNext = false;
    const recovered = await resolveSeatAreaScope(dmCtx);
    assert.equal(reads, 2, "🔴 the next request reads the organogram again — the failure was not cached");
    assert.deepEqual([...(recovered?.areaCodes ?? [])], ["UE1"], "and gets his real areas");
    await resolveSeatAreaScope(dmCtx);
    assert.equal(reads, 2, "a real answer IS cached");
  } finally {
    console.log = originalLog;
    __setSeatAreaInputsLoaderForTests(null);
    __resetSeatAreaScopeCacheForTests();
  }
}
