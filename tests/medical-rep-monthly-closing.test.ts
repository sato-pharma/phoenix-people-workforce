import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { employeePortalNavigationSections } from "../src/config/system-navigation.ts";
import type { AccessContext, PhoenixRole } from "../src/lib/auth/permissions.ts";
import { resolveEmployeePortalNavVisibility } from "../src/lib/employee-portal/navigation.ts";
import { computeSalesAccessScope } from "../src/lib/sales/access-scope.ts";
import { SYNTHETIC_DIRECT_AREA_CODE } from "../src/lib/sales/closing-direct-area.ts";
import { closingAreaOf } from "../src/lib/sales/closing-row-area.ts";
import {
  assembleComparison,
  comparisonLeavesFromRows,
  scopeComparisonInput,
  type AssembleComparisonInput,
  type ComparisonSourceRow,
} from "../src/lib/sales/monthly-closing-comparison.ts";
import { applyDetailScope, type ClosingDetailRow } from "../src/lib/sales/monthly-closing-details.ts";
import {
  applyRegionScope,
  canAccessPortalClosing,
  medicalRepClosingGeography,
  medicalRepComparisonScope,
} from "../src/lib/sales/monthly-closing-portal.ts";
import type { MonthlyClosingCell, MonthlyClosingMatrix } from "../src/lib/sales/monthly-distributor-import.ts";

/**
 * Owner, 2026-09-16: "show monthly closing his scope in medical reps accounts".
 *
 * A Medical Rep now opens the portal Monthly Closing tab. What this file protects is WHICH closing they
 * see: their OWN area(s), and nothing wider. The sales engine reads a rep's SELF scope at REGION level,
 * and their region holds every sibling rep's area — a rep at their own rank, which the owner's standing
 * rule keeps out of anyone's scope ("scope runs downward only"). The portal closing tab, its Details
 * tab and its Excel export all used to take exactly that region bound for the roles they served. So
 * the rep's bound REPLACES the region bound on each of the three, rather than narrowing inside it:
 *
 *   • the matrix — medicalRepClosingGeography: their areas, and an EMPTY region set, so an area that
 *     matches nothing shows nothing instead of falling back to their region or the line;
 *   • the Details tab and the scoped export's Data sheet — applyDetailScope's closing-area bound,
 *     matched on the area the Closing Matrix books a row in, so the rows are the ones behind their row;
 *   • the scoped export's comparison sheets — medicalRepComparisonScope trims the company-wide
 *     master lists their white space is measured against to the rep's own areas (the owner's
 *     decision, asked because that export is frozen: a rep's file only; every other viewer's file is
 *     unchanged);
 *   • a rep whose area is not on file gets a message, never their region instead.
 */

const CAIRO_REP_AREA = "CA1";
const CAIRO_SIBLING_AREA = "CA2";
const DELTA_AREA = "D11";

function cell(salesValue: number, salesUnits: number): MonthlyClosingCell {
  return { salesUnits, salesValue, targetUnits: null, targetValue: null, achievement: null };
}

function areaRow(areaCode: string, regionCode: string, regionName: string, cells: MonthlyClosingCell[], isDirect = false) {
  const rowTotal = cell(
    cells.reduce((sum, c) => sum + c.salesValue, 0),
    cells.reduce((sum, c) => sum + c.salesUnits, 0),
  );
  return { kind: "area" as const, areaCode, areaName: `${areaCode} Area`, regionCode, regionName, cells, rowTotal, isDirect };
}

/**
 * Two regions. Cairo holds the rep's own area, a SIBLING rep's area and the synthetic Direct row;
 * Delta (1) holds a third area. The totals are what the unscoped closing would print.
 */
function buildMatrix(): MonthlyClosingMatrix {
  const cairoAreas = [
    areaRow(CAIRO_REP_AREA, "CA", "Cairo", [cell(100, 10), cell(200, 20)]),
    areaRow(CAIRO_SIBLING_AREA, "CA", "Cairo", [cell(40, 4), cell(50, 5)]),
    areaRow(SYNTHETIC_DIRECT_AREA_CODE, "CA", "Cairo", [cell(7, 1), cell(9, 1)], true),
  ];
  const deltaAreas = [areaRow(DELTA_AREA, "D1", "Delta (1)", [cell(300, 30), cell(400, 40)])];
  const cairoCells = [cell(147, 15), cell(259, 26)];
  const deltaCells = [cell(300, 30), cell(400, 40)];
  const grandCells = [cell(447, 45), cell(659, 66)];
  return {
    availableLines: ["Pedia"],
    availablePeriods: ["2026-08"],
    columns: [
      { family: "F", productCode: "P1", productName: "Prod 1" },
      { family: "F", productCode: "P2", productName: "Prod 2" },
    ],
    line: "Pedia",
    period: "2026-08",
    regions: [
      {
        regionCode: "CA",
        regionName: "Cairo",
        areas: cairoAreas,
        subtotal: { kind: "regionSubtotal", regionCode: "CA", regionName: "Cairo", cells: cairoCells, rowTotal: cell(406, 41) },
      },
      {
        regionCode: "D1",
        regionName: "Delta (1)",
        areas: deltaAreas,
        subtotal: { kind: "regionSubtotal", regionCode: "D1", regionName: "Delta (1)", cells: deltaCells, rowTotal: cell(700, 70) },
      },
    ],
    grandTotal: { kind: "grandTotal", cells: grandCells, rowTotal: cell(1106, 111) },
    directNational: { kind: "regionSubtotal", regionCode: "", regionName: "Direct", cells: [cell(7, 1), cell(9, 1)], rowTotal: cell(16, 2) },
    companyTotal: { kind: "grandTotal", cells: grandCells, rowTotal: cell(1106, 111) },
  } as unknown as MonthlyClosingMatrix;
}

function areaCodesOf(matrix: MonthlyClosingMatrix): string[] {
  return matrix.regions.flatMap((region) => region.areas.map((area) => area.areaCode));
}

function detailRow(
  id: number,
  fields: { areaCode: string; sheetAreaCode: string; regionCode: string; productCode: string; isConfidential?: boolean },
): ClosingDetailRow {
  return { id, isConfidential: false, ...fields } as unknown as ClosingDetailRow;
}

function idsOf(rows: ClosingDetailRow[]): number[] {
  return rows.map((row) => row.id).sort((left, right) => left - right);
}

/** Line endings normalised, so a CRLF checkout matches the same substrings CI's LF checkout does. */
function readSource(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

export function runMedicalRepMonthlyClosingTests() {
  // ── The door: three gates agree for the rep ────────────────────────────────
  const rep: PhoenixRole = "Medical Rep";
  assert.equal(
    canAccessPortalClosing({ role: rep } as unknown as AccessContext),
    true,
    "the portal closing page redirects anyone outside PORTAL_CLOSING_ROLES — the owner opened it to the Medical Rep",
  );
  assert.equal(
    resolveEmployeePortalNavVisibility(rep, rep).showMonthlyClosingTab,
    true,
    "the portal sidebar flag must agree with the server gate, or their tab is a door nobody can see",
  );
  const closingRow = employeePortalNavigationSections
    .flatMap((section) => section.items)
    .find((item) => item.href === "/employee-portals/monthly-closing");
  assert.ok(closingRow, "the portal Monthly Closing catalog row still exists");
  assert.ok(
    (closingRow.roles ?? []).includes(rep),
    "and its catalog row names the Medical Rep, so the role catalog and the sidebar agree",
  );

  // ── Why the portal cannot take the engine's bound for them ─────────────────
  // Their SELF scope is REGION-level: every sibling rep's area in Cairo. This is the bound the tab,
  // the Details tab and the export used for every role before them, and exactly what must NOT reach
  // them. It is also why the whole-line premium export and PDF refuse them (both check canViewAllSales).
  const engine = computeSalesAccessScope({
    role: rep,
    businessScope: "SELF",
    viewerLineName: "Pedia",
    viewerRegionName: "Cairo",
    includeRestricted: false,
  });
  assert.equal(engine.canViewAllSales, false, "a rep never holds whole-line sales — the premium export and PDF refuse them");
  assert.deepEqual([...(engine.allowedRegionNames ?? [])], ["cairo"], "the engine bounds a rep by their REGION");
  assert.equal(engine.allowedAreaCodes, null, "and carries no area bound for them at all");

  // Control: that region bound, applied to the matrix, hands them their sibling's area. If this ever
  // stops holding, the fixture can no longer see the leak the assertions below exist to catch.
  assert.ok(
    areaCodesOf(applyRegionScope(buildMatrix(), engine.allowedRegionNames, engine.allowedAreaCodes)).includes(CAIRO_SIBLING_AREA),
    "control: the region bound shows the sibling rep's area",
  );

  // ── The matrix: their own area, nothing else ─────────────────────────────────
  const own = medicalRepClosingGeography(["ca1"]);
  assert.equal(own.regionNames?.size, 0, "their region set is EMPTY, never their region label");
  assert.deepEqual([...(own.areaCodes ?? [])], [CAIRO_REP_AREA], "their area codes, upper-cased");
  assert.equal(own.areaUnresolved, false, "an area on file is resolved");

  const scoped = applyRegionScope(buildMatrix(), own.regionNames, own.areaCodes);
  assert.deepEqual(
    areaCodesOf(scoped),
    [CAIRO_REP_AREA],
    "🔴 a Medical Rep sees THEIR OWN area only — not the sibling rep beside them in Cairo, not the Direct row, not Delta (1)",
  );
  assert.equal(scoped.regions[0]?.subtotal.cells[0]?.salesValue, 100, "Cairo's subtotal is recomputed from their area alone, never the region's 147");
  assert.equal(scoped.grandTotal.rowTotal.salesValue, 300, "the grand total is their area's 300, never the line's 1106");
  assert.equal(scoped.grandTotal.cells[1]?.salesUnits, 20, "units recomputed the same way");
  assert.equal(scoped.directNational, null, "no national direct figure for a rep");
  assert.equal(scoped.companyTotal, null, "and no company total");

  // A rep covering two Source of Sales codes (the crosswalk can answer more than one) sees both.
  const twoAreaBound = medicalRepClosingGeography([CAIRO_REP_AREA, DELTA_AREA]);
  const twoAreas = applyRegionScope(buildMatrix(), twoAreaBound.regionNames, twoAreaBound.areaCodes);
  assert.deepEqual(areaCodesOf(twoAreas).sort(), [CAIRO_REP_AREA, DELTA_AREA], "every area of their own, and still no sibling");
  assert.equal(twoAreas.grandTotal.cells[0]?.salesValue, 400, "grand total is their two areas' 100 + 300");

  // 🔴 Their area matches no row in this closing: NOTHING — never their region, never the whole line.
  // The same area set with a NULL region bound (a District Manager's seat semantics) is empty too since
  // 2026-10-26 — it used to fail open to the whole line.
  const unmatched = medicalRepClosingGeography(["ZZ9"]);
  const unmatchedMatrix = applyRegionScope(buildMatrix(), unmatched.regionNames, unmatched.areaCodes);
  assert.equal(
    unmatchedMatrix.regions.length,
    0,
    "🔴 a rep whose area has no row sees an empty closing — falling back would show them their region or the whole line",
  );
  assert.equal(unmatchedMatrix.grandTotal.rowTotal.salesValue, 0, "and a zero total, not the line's");
  assert.equal(
    applyRegionScope(buildMatrix(), null, unmatched.areaCodes).regions.length,
    0,
    "🔴 the same unmatched area with a NULL region bound is empty too — a seat-scoped viewer never widens",
  );

  // No area on file: unresolved, both bounds empty, no rows — and the page shows a message.
  for (const [label, codes] of [["null", null], ["empty", []], ["blank", ["  "]]] as const) {
    const unresolved = medicalRepClosingGeography(codes as readonly string[] | null);
    assert.equal(unresolved.areaUnresolved, true, `${label} area codes read as "no area on file"`);
    assert.equal(
      applyRegionScope(buildMatrix(), unresolved.regionNames, unresolved.areaCodes).regions.length,
      0,
      `${label} area codes show nothing, never their region`,
    );
  }

  // ── The Details tab and the scoped export's Data sheet ─────────────────────
  const rows = [
    detailRow(1, { areaCode: CAIRO_REP_AREA, sheetAreaCode: CAIRO_REP_AREA, regionCode: "CA", productCode: "P1" }),
    detailRow(2, { areaCode: CAIRO_SIBLING_AREA, sheetAreaCode: CAIRO_SIBLING_AREA, regionCode: "CA", productCode: "P1" }),
    // Booked by the closing IN their area although the customer's brick sits in the sibling's.
    detailRow(3, { areaCode: CAIRO_SIBLING_AREA, sheetAreaCode: CAIRO_REP_AREA, regionCode: "CA", productCode: "P2" }),
    // The reverse: the customer's brick is theirs, but the closing books the row in the sibling's area.
    detailRow(4, { areaCode: CAIRO_REP_AREA, sheetAreaCode: CAIRO_SIBLING_AREA, regionCode: "CA", productCode: "P2" }),
    detailRow(5, { areaCode: DELTA_AREA, sheetAreaCode: DELTA_AREA, regionCode: "D1", productCode: "P1" }),
    // No sheet area: the closing falls back to the resolved area.
    detailRow(6, { areaCode: CAIRO_REP_AREA, sheetAreaCode: "", regionCode: "CA", productCode: "P1" }),
    detailRow(7, { areaCode: CAIRO_REP_AREA, sheetAreaCode: CAIRO_REP_AREA, regionCode: "CA", productCode: "P1", isConfidential: true }),
  ];
  // What loadMonthlyClosingDetails hands applyDetailScope for a rep: the engine's region codes, which
  // the rep bound must override, plus their own area codes as the closing-area bound.
  const repDetailScope = {
    allowedRegionCodes: new Set(["CA"]),
    allowedAreaCodes: null,
    allowedClosingAreaCodes: new Set([CAIRO_REP_AREA]),
    allowedProductCodes: null,
    dropConfidential: true,
  };

  const control = applyDetailScope(rows, { ...repDetailScope, allowedClosingAreaCodes: null });
  assert.deepEqual(idsOf(control), [1, 2, 3, 4, 6], "control: the region bound alone lists the sibling rep's rows");

  const repRows = applyDetailScope(rows, repDetailScope);
  assert.deepEqual(
    idsOf(repRows),
    [1, 3, 6],
    "🔴 their Details rows are exactly the ones the closing books in THEIR area — never the sibling's, never Delta (1), never a confidential row",
  );
  assert.ok(
    repRows.every((row) => own.areaCodes?.has(closingAreaOf(row))),
    "every row they are shown sits behind their own matrix row, so the Details tab ties to the matrix beside it",
  );
  assert.deepEqual(
    idsOf(applyDetailScope(rows, { ...repDetailScope, allowedClosingAreaCodes: new Set([" ca1 "]) })),
    [1, 3, 6],
    "codes are matched trimmed and case-insensitively",
  );
  assert.deepEqual(
    idsOf(applyDetailScope(rows, { ...repDetailScope, allowedAreaCodes: new Set([CAIRO_SIBLING_AREA]) })),
    [1, 3, 6],
    "their bound replaces a seat-area bound as well as the region bound — it never unions with either",
  );
  assert.deepEqual(
    idsOf(applyDetailScope(rows, { ...repDetailScope, allowedProductCodes: new Set(["P2"]) })),
    [3],
    "the product and confidential gates still apply inside their area",
  );
  assert.equal(
    applyDetailScope(rows, { ...repDetailScope, allowedAreaCodes: new Set([CAIRO_REP_AREA]), allowedClosingAreaCodes: new Set<string>() }).length,
    0,
    "🔴 an EMPTY own-area bound fails closed — it never falls through to the region or seat bound",
  );

  // ── The scoped export's comparison sheets ──────────────────────────────────
  // Owner, 2026-09-16, asked because the old export is frozen: narrow it for reps only. Gaps &
  // White-Space, Summary & Insights and the hidden Calc sheet measure white space against MASTER lists
  // of every area and brick in the company. The rep's rows are the own-area rows above; the masters
  // are what must follow them.
  const sourceRow = (
    fields: Partial<ComparisonSourceRow> & Pick<ComparisonSourceRow, "areaCode" | "salesValue">,
  ): ComparisonSourceRow => ({
    brickId: "", brickName: "", clientCode: "", clientName: "", distributorCode: "DS", includedInClosing: true,
    productCode: "P1", productName: "Prod 1", qty: 1, regionCode: "CA", ...fields,
  });
  const comparisonInput: AssembleComparisonInput = {
    // The rep's export rows: one from the rep's own brick, and one the closing books in the rep's area
    // from a brick in the sibling's area (row 3 above), which must survive the narrowing.
    ...comparisonLeavesFromRows([
      sourceRow({ areaCode: CAIRO_REP_AREA, sheetAreaCode: CAIRO_REP_AREA, brickId: "B-CA1", clientCode: "C1", clientName: "Pharmacy One", salesValue: 100 }),
      sourceRow({ areaCode: CAIRO_SIBLING_AREA, sheetAreaCode: CAIRO_REP_AREA, brickId: "B-CA2", clientCode: "C2", clientName: "Pharmacy Two", productCode: "P2", productName: "Prod 2", salesValue: 40 }),
    ]),
    line: "Pedia",
    maps: {
      areaName: new Map([[CAIRO_REP_AREA, "Rep Area"], [CAIRO_SIBLING_AREA, "Sibling Area"], [DELTA_AREA, "Delta Area"]]),
      areaRegion: new Map([[CAIRO_REP_AREA, "CA"], [CAIRO_SIBLING_AREA, "CA"], [DELTA_AREA, "D1"]]),
      distributorName: new Map([["DS", "Distributor"]]),
      regionName: new Map([["CA", "Cairo"], ["D1", "Delta (1)"]]),
    },
    masterAreas: [
      { areaCode: CAIRO_REP_AREA, areaName: "Rep Area", regionCode: "CA" },
      { areaCode: CAIRO_SIBLING_AREA, areaName: "Sibling Area", regionCode: "CA" },
      { areaCode: DELTA_AREA, areaName: "Delta Area", regionCode: "D1" },
    ],
    masterBricks: [
      { areaCode: CAIRO_REP_AREA, brickId: "B-CA1", brickName: "Rep Brick", regionCode: "CA" },
      { areaCode: CAIRO_REP_AREA, brickId: "B-CA1-IDLE", brickName: "Rep Idle Brick", regionCode: "CA" },
      { areaCode: CAIRO_SIBLING_AREA, brickId: "B-CA2", brickName: "Sibling Brick", regionCode: "CA" },
      { areaCode: DELTA_AREA, brickId: "B-D11", brickName: "Delta Brick", regionCode: "D1" },
    ],
    period: "2026-08",
  };

  // Control: no scope — what every other viewer's file is still built with — names the sibling's area
  // and the rest of the country as white space. If this stops holding, the fixture cannot see the leak.
  const unscopedComparison = assembleComparison(scopeComparisonInput(comparisonInput, undefined));
  assert.deepEqual(
    unscopedComparison.whiteSpace.zeroSalesAreas.map((area) => area.areaCode).sort(),
    [CAIRO_SIBLING_AREA, DELTA_AREA],
    "control: with no scope the Gaps sheet lists the sibling rep's area and the rest of the country as zero sales",
  );

  const repComparisonScope = medicalRepComparisonScope(["ca1"]);
  assert.deepEqual(repComparisonScope, { areaCodes: [CAIRO_REP_AREA] }, "a rep's comparison scope is the rep's own area codes, upper-cased");
  const repComparison = assembleComparison(scopeComparisonInput(comparisonInput, repComparisonScope ?? undefined));
  assert.deepEqual(
    repComparison.whiteSpace.zeroSalesAreas,
    [],
    "🔴 a rep's Gaps & White-Space sheet names no other area as zero sales — not the sibling rep's, not Delta (1)'s",
  );
  assert.deepEqual(
    repComparison.data.masterAreas.map((area) => area.areaCode),
    [CAIRO_REP_AREA],
    "🔴 and the hidden Calc sheet's area list holds the rep's own area only",
  );
  assert.deepEqual(
    repComparison.data.masterBricks.map((brick) => brick.brickId).sort(),
    ["B-CA1", "B-CA1-IDLE"],
    "its brick list holds the rep's own bricks only",
  );
  assert.deepEqual(
    repComparison.whiteSpace.zeroSalesBricks.map((brick) => brick.brickId),
    ["B-CA1-IDLE"],
    "the white space the rep can act on — an idle brick in the rep's own area — is still reported",
  );
  assert.equal(repComparison.totalAreas, 1, "the Summary's \"N of M areas\" counts the rep's areas, never the country's");
  assert.equal(
    repComparison.national.value,
    unscopedComparison.national.value,
    "the narrowing drops none of the rep's sales — the row booked in from the sibling's brick stays",
  );
  assert.ok(
    unscopedComparison.whiteSpace.productGaps.flatMap((gap) => gap.missingRegions).includes("Delta (1)")
      && !repComparison.whiteSpace.productGaps.flatMap((gap) => gap.missingRegions).includes("Delta (1)"),
    "product gaps stop naming regions outside the rep's own area",
  );

  // No area on file is null — the export refuses — never an empty list, which scopeComparisonInput
  // reads as "no filter" and would hand the rep the whole country again.
  for (const [label, codes] of [["null", null], ["empty", []], ["blank", ["  "]]] as const) {
    assert.equal(
      medicalRepComparisonScope(codes as readonly string[] | null),
      null,
      `${label} area codes give no comparison scope, so the export refuses`,
    );
  }
  assert.equal(
    scopeComparisonInput(comparisonInput, { areaCodes: [] }).masterAreas.length,
    3,
    "control: an empty area list is no filter at all — which is why unresolved must be null",
  );

  // ── The wiring, pinned at source ───────────────────────────────────────────
  // The pure functions above prove the bound. They cannot prove the loaders hand it to them — both
  // loaders read the database. Matched as substrings, never byte offsets.
  const portal = readSource("../src/lib/sales/monthly-closing-portal.ts");
  const scopeStart = portal.indexOf("export async function resolvePortalClosingScope(");
  const scopeBody = portal.slice(scopeStart, portal.indexOf("\n}\n", scopeStart));
  assert.ok(scopeStart >= 0, "resolvePortalClosingScope is still where it was");
  assert.ok(
    scopeBody.includes("isMedicalRep ? resolveMedicalRepSosAreaCodes(access)"),
    "the portal scope resolves a rep's own areas through the shared resolver",
  );
  const repReturnAt = scopeBody.indexOf("...medicalRepClosingGeography(repAreaCodes)");
  assert.ok(repReturnAt > 0, "and returns their bound from medicalRepClosingGeography — never the engine's region bound");
  assert.ok(
    repReturnAt < scopeBody.indexOf("PRODUCT_SCOPED_CLOSING_ROLES.has(access.role)"),
    "the rep branch returns before the branches that hand out the engine's region bound",
  );
  assert.ok(
    portal.includes("if (scope.areaUnresolved) {") && portal.includes("scopeMessage: MEDICAL_REP_AREA_UNRESOLVED_MESSAGE"),
    "a rep with no area on file gets the plain-words message, not an empty closing",
  );

  const details = readSource("../src/lib/sales/monthly-closing-details.ts");
  assert.ok(
    details.includes("resolveMedicalRepSosAreaCodes(access, { references })")
      && details.includes("if (!repAreaCodes) return empty(true);"),
    "the Details loader resolves the SAME areas for a rep and refuses when they have none",
  );
  assert.ok(
    details.includes("allowedClosingAreaCodes: repClosingAreaCodes"),
    "and hands them to applyDetailScope — the Details tab and the scoped export's Data sheet both read this loader",
  );

  // One resolver, so the drilldown, the pharmacy action lists and the closing can never disagree
  // about which areas are theirs.
  const rootScope = readSource("../src/lib/sales/territory/root-scope.ts");
  assert.ok(rootScope.includes("resolveMedicalRepSosAreaCodes(ctx)"), "the territory drilldown uses the shared resolver");
  assert.equal(
    rootScope.includes("phx_territory_resolve_sos_area_codes"),
    false,
    "and holds no second copy of the area chain that could drift from the closing's",
  );

  // The scoped export hands the comparison the rep's scope, for a Medical Rep and no other role.
  const exportRoute = readSource("../app/api/sales/monthly-closing/export/route.ts");
  assert.ok(
    exportRoute.includes(
      'const repComparisonScope = access.role === "Medical Rep"\n'
        + "      ? medicalRepComparisonScope(await resolveMedicalRepSosAreaCodes(access))\n"
        + "      : undefined;",
    ),
    "the scoped export narrows the comparison for a Medical Rep only — every other viewer keeps no scope",
  );
  assert.ok(
    exportRoute.includes("if (repComparisonScope === null) {"),
    "and refuses a rep with no area on file rather than build the country-wide lists",
  );
  assert.ok(
    exportRoute.includes('loadMonthlyClosingComparisonFromRows(details.line, details.period, details.rows, repComparisonScope, access, { regionBasis: "organogram" })'),
    "and hands that scope to the comparison the workbook's sheets are built from",
  );

  // Their only export is the scoped one: the whole-line premium workbook and its PDF refuse them.
  assert.ok(
    readSource("../app/api/sales/monthly-closing/premium-export/route.ts").includes("if (!scope.canViewAllSales) {"),
    "the premium export still refuses a viewer without whole-line sales",
  );
  assert.ok(
    readSource("../app/api/sales/monthly-closing/premium-export/pdf/route.ts").includes("if (!scope.canViewAllSales) return refusal(request, 403"),
    "and so does its PDF",
  );

  // ── The rep's OWN-AREA, vertical front view (owner, 2026-09-23) ─────────────
  // Their matrix is already scoped to their own area, so the shared ClosingMatrixTable draws them
  // three rows for that one area (area / region subtotal / National Grand Total) with products laid
  // across as columns — a horizontal scroll. The owner: show his area only, stacked down the page.
  // This is presentation wiring the pure tests above cannot reach, so it is pinned at source.
  const page = readSource("../app/employee-portals/monthly-closing/page.tsx");
  assert.ok(
    page.includes('const isMedicalRep = access.role === "Medical Rep";'),
    "the page decides the rep view from the viewer's role",
  );
  assert.ok(
    page.includes("isMedicalRep={isMedicalRep}"),
    "and threads it to the view so the rep gets the vertical surface",
  );

  const view = readSource("../src/components/sales/portal-monthly-closing-view.tsx");
  assert.ok(
    view.includes('import { PortalRepClosingList } from "@/components/sales/portal-rep-closing-list";'),
    "the view imports the rep's vertical list",
  );
  assert.ok(
    view.includes("<PortalRepClosingList matrix={filteredMatrix} />"),
    "🔴 a Medical Rep renders the stacked own-area list, never the wide ClosingMatrixTable",
  );

  const repList = readSource("../src/components/sales/portal-rep-closing-list.tsx");
  assert.ok(repList.includes("export function PortalRepClosingList("), "the rep list component exists");
  assert.ok(
    repList.includes("region.areas"),
    "it renders the rep's own AREAS",
  );
  assert.ok(
    repList.includes("isSyntheticDirectArea"),
    "and drops the synthetic company Direct pseudo-area",
  );
  assert.equal(
    repList.includes("grandTotal"),
    false,
    "🔴 the rep view never draws the National Grand Total — it is their own area restated",
  );
  assert.equal(
    repList.includes(".subtotal"),
    false,
    "🔴 nor the region subtotal — the one thing the owner asked to remove",
  );
}
