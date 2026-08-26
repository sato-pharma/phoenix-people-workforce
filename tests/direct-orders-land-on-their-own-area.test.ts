import assert from "node:assert/strict";

import {
  DIRECT_AREA_STAMPED_FROM_PERIOD,
  directRowsCarryOwnArea,
  isSyntheticDirectArea,
} from "../src/lib/sales/closing-direct-area.ts";
import {
  buildMonthlyClosingMatrix,
  injectDirectIntoMatrix,
  type MonthlyClosingDirectCell,
  type SalesReferenceData,
} from "../src/lib/sales/monthly-distributor-import.ts";

/**
 * From 2026-08 the Direct Orders module stamps the customer's real area and brick on every row it
 * books, and `au.f_monthly_attribution` already credits that area's rep for the money. The Closing
 * Matrix was the last surface still discarding it: production 2026-08 Pedia showed
 * "Direct orders (company)" carrying 216 Lacto Advanced 1 units while Giza - Giza Centers — the area
 * that actually earned them, and whose rep was already credited — read 0 two rows above.
 *
 * These tests pin the fix in both directions. The failure they are built to catch is not the obvious
 * one: the risk is that a change intended for 2026-08 quietly moves an OLDER month, because those
 * months are published and two of them are locked.
 *
 * And "older month" does NOT mean "has no area" — that assumption is exactly the trap. 2026-01 has
 * 19 of 71 direct rows carrying a manually-placed area and 2026-07 has 35 of 51, July's being the
 * owner's own finalized mapping. The rule is therefore a PERIOD FLOOR
 * (`DIRECT_AREA_STAMPED_FROM_PERIOD`), and scenario 5 is the one that pins it.
 */

const references: SalesReferenceData = {
  distributors: [
    { code: "PS", name: "overseas" },
    { code: "Direct", name: "Direct (Company)" },
  ],
  products: [
    { factoryPrice: 10, family: "CNS", familyCode: "CNS", line: "Pedia", productCode: "P-A", productName: "Product A", source: "" },
    { factoryPrice: 50, family: "Pedia", familyCode: "PED", line: "Pedia", productCode: "P-B", productName: "Product B", source: "" },
  ],
  regions: [
    { areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" },
    { areaCode: "A2", areaName: "Area Two", regionCode: "CA", regionName: "Cairo" },
    { areaCode: "B1", areaName: "Area Three", regionCode: "AB", regionName: "Alex" },
  ],
  areas: [
    { areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" },
    { areaCode: "A2", areaName: "Area Two", regionCode: "CA", regionName: "Cairo" },
    { areaCode: "B1", areaName: "Area Three", regionCode: "AB", regionName: "Alex" },
  ],
  blocks: [],
  bricks: [],
};

function baseMatrix(period: string) {
  return buildMonthlyClosingMatrix({
    areas: references.areas ?? [],
    availableLines: ["Pedia"],
    availablePeriods: [period],
    cells: [
      { areaCode: "A1", productCode: "P-A", salesUnits: 4, salesValue: 40 },
      { areaCode: "A2", productCode: "P-B", salesUnits: 2, salesValue: 100 },
      { areaCode: "B1", productCode: "P-A", salesUnits: 6, salesValue: 60 },
    ],
    line: "Pedia",
    period,
    products: references.products,
  });
}

const areaRow = (matrix: ReturnType<typeof baseMatrix>, regionCode: string, areaCode: string) =>
  matrix.regions
    .find((region) => region.regionCode === regionCode)
    ?.areas.find((area) => area.areaCode === areaCode);

const directRows = (matrix: ReturnType<typeof baseMatrix>) =>
  matrix.regions.flatMap((region) => region.areas.filter((area) => isSyntheticDirectArea(area)));

const grandUnits = (matrix: ReturnType<typeof baseMatrix>, index: number) =>
  matrix.grandTotal.cells[index]?.salesUnits ?? 0;

export async function runDirectOrdersLandOnTheirOwnAreaTests() {
  const columnOf = (matrix: ReturnType<typeof baseMatrix>, productCode: string) =>
    matrix.columns.findIndex((column) => column.productCode === productCode);

  // ── 1. HEADLINE. A direct cell that names its area folds into that area's row ──────────────
  // This is the assertion the whole change exists for. Break the merge and this fires first.
  {
    const matrix = baseMatrix("2026-08");
    const iA = columnOf(matrix, "P-A");
    const cells: MonthlyClosingDirectCell[] = [
      { areaCode: "A1", productCode: "P-A", regionCode: "CA", salesUnits: 216, salesValue: 57024 },
    ];
    const injected = injectDirectIntoMatrix(matrix, cells);
    const a1 = areaRow(injected, "CA", "A1");

    assert.equal(a1?.cells[iA]?.salesUnits, 220, "Area One must carry its own 216 direct units on top of its 4 distributor units");
    assert.equal(a1?.cells[iA]?.salesValue, 57064, "direct value is ADDED as-is (40 + 57,024) — never recomputed at factory price");
    assert.equal(a1?.isDirect, true, "an area that absorbed direct must be flagged so the export writes it statically");
    assert.deepEqual(directRows(injected), [], 'no anonymous "Direct orders (company)" row when every direct cell has an area');
    assert.equal(injected.directNational, null, "area-bearing direct is not National money");
  }

  // ── 2. REGRESSION. A direct cell with NO area keeps the named Direct row ───────────────────
  // Every month from 2026-02 to 2026-07 looks like this. Two of them are locked closings.
  {
    const matrix = baseMatrix("2026-05");
    const iA = columnOf(matrix, "P-A");
    const cells: MonthlyClosingDirectCell[] = [
      { areaCode: "", productCode: "P-A", regionCode: "CA", salesUnits: 216, salesValue: 57024 },
    ];
    const injected = injectDirectIntoMatrix(matrix, cells);

    assert.equal(areaRow(injected, "CA", "A1")?.cells[iA]?.salesUnits, 4, "an area-less direct cell must NOT touch a real area row");
    assert.equal(areaRow(injected, "CA", "A1")?.isDirect ?? false, false, "and must not flag that area as direct-bearing");
    const rows = directRows(injected);
    assert.equal(rows.length, 1, "area-less direct still gets its own named row");
    assert.equal(rows[0]?.regionCode, "CA");
    assert.equal(rows[0]?.cells[iA]?.salesUnits, 216);
  }

  // ── 3. A MIXED month: both kinds at once, totals conserved ─────────────────────────────────
  {
    const matrix = baseMatrix("2026-08");
    const iA = columnOf(matrix, "P-A");
    const before = grandUnits(matrix, iA); // 4 + 6 = 10 distributor units
    const cells: MonthlyClosingDirectCell[] = [
      { areaCode: "A1", productCode: "P-A", regionCode: "CA", salesUnits: 100, salesValue: 1000 },
      { areaCode: "", productCode: "P-A", regionCode: "CA", salesUnits: 30, salesValue: 300 },
      { areaCode: "B1", productCode: "P-A", regionCode: "AB", salesUnits: 7, salesValue: 70 },
    ];
    const injected = injectDirectIntoMatrix(matrix, cells);

    assert.equal(areaRow(injected, "CA", "A1")?.cells[iA]?.salesUnits, 104);
    assert.equal(areaRow(injected, "AB", "B1")?.cells[iA]?.salesUnits, 13);
    const rows = directRows(injected);
    assert.equal(rows.length, 1, "only the area-less 30 units keep an anonymous row");
    assert.equal(rows[0]?.cells[iA]?.salesUnits, 30);

    // The region subtotal is the sum of its own rows, and the grand total gained exactly the direct
    // money — no cell counted twice, none dropped.
    const cairo = injected.regions.find((region) => region.regionCode === "CA");
    const cairoRowSum = cairo?.areas.reduce((sum, area) => sum + (area.cells[iA]?.salesUnits ?? 0), 0) ?? 0;
    assert.equal(cairo?.subtotal.cells[iA]?.salesUnits, cairoRowSum, "region subtotal must be rebuilt after the merge");
    assert.equal(grandUnits(injected, iA), before + 137, "grand total = distributor + every direct unit, counted once");
  }

  // ── 4. LATENT-DROP GUARD. Direct naming an area this matrix does not carry must not vanish ──
  {
    const matrix = baseMatrix("2026-08");
    const iA = columnOf(matrix, "P-A");
    const before = grandUnits(matrix, iA);
    const cells: MonthlyClosingDirectCell[] = [
      { areaCode: "ZZ9", productCode: "P-A", regionCode: "CA", salesUnits: 55, salesValue: 550 },
    ];
    const injected = injectDirectIntoMatrix(matrix, cells);

    const rows = directRows(injected);
    assert.equal(rows.length, 1, "unplaceable area money rejoins its region's Direct row rather than disappearing");
    assert.equal(rows[0]?.regionCode, "CA");
    assert.equal(rows[0]?.cells[iA]?.salesUnits, 55);
    assert.equal(grandUnits(injected, iA), before + 55, "and the grand total still holds");
  }

  // ── 5. THE PERIOD FLOOR. An older month must not fold even when handed a real area ─────────
  // The sharp case, and the reason this is a floor rather than a has-an-area test: 2026-01 has 19
  // of 71 direct rows carrying a manually-placed area, and 2026-07 has 35 of 51 — July's being the
  // owner's own finalized mapping. July's mapping table covers Anti Infective and Pedia only, so
  // July CNS reaches THIS code path in production, over a locked closing. If the SQL floor is ever
  // removed, or a caller hands these cells in directly, the fold must still refuse.
  for (const period of ["2026-01", "2026-07"]) {
    const matrix = baseMatrix(period);
    const iA = columnOf(matrix, "P-A");
    const before = grandUnits(matrix, iA);
    const cells: MonthlyClosingDirectCell[] = [
      { areaCode: "A1", productCode: "P-A", regionCode: "CA", salesUnits: 216, salesValue: 57024 },
    ];
    const injected = injectDirectIntoMatrix(matrix, cells);

    assert.equal(
      areaRow(injected, "CA", "A1")?.cells[iA]?.salesUnits,
      4,
      `${period} predates the Direct Orders module stamping an area — its direct money must NOT move onto Area One`,
    );
    assert.equal(areaRow(injected, "CA", "A1")?.isDirect ?? false, false, `${period}: and the area must not be flagged direct-bearing`);
    const rows = directRows(injected);
    assert.equal(rows.length, 1, `${period}: the money keeps the anonymous Direct row it has always had`);
    assert.equal(rows[0]?.cells[iA]?.salesUnits, 216, `${period}: and keeps every unit`);
    assert.equal(grandUnits(injected, iA), before + 216, `${period}: the grand total is unchanged by the floor`);
  }

  // The floor is one exported rule, not a literal repeated at each call site.
  assert.equal(DIRECT_AREA_STAMPED_FROM_PERIOD, "2026-08");
  assert.equal(directRowsCarryOwnArea("2026-07"), false, "July is below the floor");
  assert.equal(directRowsCarryOwnArea("2026-08"), true, "August is the first month at or above it");
  assert.equal(directRowsCarryOwnArea("2026-09"), true, "and every later month stays above it");
  assert.equal(directRowsCarryOwnArea(""), false, "an unknown period never folds");

  // ── 6. The National bucket is untouched by any of this ─────────────────────────────────────
  {
    const matrix = baseMatrix("2026-08");
    const iA = columnOf(matrix, "P-A");
    const cells: MonthlyClosingDirectCell[] = [
      { areaCode: "A1", productCode: "P-A", regionCode: "CA", salesUnits: 10, salesValue: 100 },
      { areaCode: "", productCode: "P-A", regionCode: "NATIONAL", salesUnits: 9, salesValue: 90 },
    ];
    const injected = injectDirectIntoMatrix(matrix, cells);

    assert.equal(injected.directNational?.cells[iA]?.salesUnits, 9, "National direct still prints once, above the total");
    assert.equal(
      injected.companyTotal?.cells[iA]?.salesUnits,
      grandUnits(injected, iA) + 9,
      "company total = grand total + National direct",
    );
    assert.deepEqual(directRows(injected), [], "National money never becomes a regional Direct row");
  }
}
