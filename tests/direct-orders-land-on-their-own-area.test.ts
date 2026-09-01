import assert from "node:assert/strict";

import {
  OVERLAY_OWNED_DIRECT_PERIODS,
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
 * owner's own finalized mapping.
 *
 * So the rule is NOT a period floor. Owner ruling 2026-09-01: honour the manual areas. Every period
 * places direct money on the row's own area, except the ones an overlay already places —
 * `OVERLAY_OWNED_DIRECT_PERIODS`, which holds July 2026 alone. Scenario 5 pins that July does not
 * fold; scenario 5b pins that January does.
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

  // ── 5. OVERLAY-OWNED JULY must not fold, even when handed a real area ─────────────────────
  // The sharp case. July 2026 has 35 of 51 direct rows carrying a manually-placed area, and that
  // placement is the OWNER'S OWN finalized mapping, applied separately by
  // `applyJulyDirectAreasToBreakdown` — which refuses to run unless the `__DIRECT__` bucket
  // reconciles to the penny. Folding the row's own area HERE would shrink that bucket, fail the
  // check, and paper the published July sheet with a "they are not the same money" warning.
  // Production's rows now carry the same 11 areas (stamped 2026-09-01 so Sales vs Target agrees),
  // which is precisely why the overlay — not the row — must stay the thing that places them.
  // If the SQL mirror is ever removed, or a caller hands these cells in directly, this must refuse.
  {
    const period = "2026-07";
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
      "July's direct money belongs to the owner's overlay — it must NOT move onto Area One here",
    );
    assert.equal(areaRow(injected, "CA", "A1")?.isDirect ?? false, false, "July: and the area must not be flagged direct-bearing");
    const rows = directRows(injected);
    assert.equal(rows.length, 1, "July: the money keeps the anonymous Direct row the overlay reconciles against");
    assert.equal(rows[0]?.cells[iA]?.salesUnits, 216, "July: and keeps every unit");
    assert.equal(grandUnits(injected, iA), before + 216, "July: the grand total is unchanged");
  }

  // ── 5b. JANUARY DOES fold — owner ruling 2026-09-01: honour the manual areas ──────────────
  // THE HEADLINE for the January half of the sales-truth repair. 2026-01 carries 17 Anti Infective
  // direct rows on 10 real areas, manually placed, no bricks, every one resolving through
  // `au.sos_area_crosswalk`. No overlay owns January, so the row's own area is the only placement
  // there is. Until 2026-09-01 a blanket pre-August floor discarded them: the closing left
  // 189,319.95 EGP sitting in the Direct band while Sales vs Target credited the ten areas, and
  // that was the last month `scripts/check-sales-truth.ts` still reported as a mismatch.
  {
    const period = "2026-01";
    const matrix = baseMatrix(period);
    const iA = columnOf(matrix, "P-A");
    const before = grandUnits(matrix, iA);
    const cells: MonthlyClosingDirectCell[] = [
      { areaCode: "A1", productCode: "P-A", regionCode: "CA", salesUnits: 216, salesValue: 57024 },
    ];
    const injected = injectDirectIntoMatrix(matrix, cells);

    assert.equal(
      areaRow(injected, "CA", "A1")?.cells[iA]?.salesUnits,
      220,
      "January's manually-placed area is honoured — its direct money lands on Area One beside the 4 distributor units",
    );
    assert.equal(directRows(injected).length, 0, "January: nothing is left stranded in an anonymous Direct row");
    assert.equal(grandUnits(injected, iA), before + 216, "January: and every unit is still counted exactly once");
  }

  // The rule is one exported list, not a literal repeated at each call site.
  assert.deepEqual(
    [...OVERLAY_OWNED_DIRECT_PERIODS],
    ["2026-07"],
    "July is the only month whose direct placement comes from an overlay rather than the row",
  );
  assert.equal(directRowsCarryOwnArea("2026-07"), false, "July's placement belongs to the owner's overlay");
  assert.equal(directRowsCarryOwnArea("2026-01"), true, "January's manual areas are honoured");
  assert.equal(directRowsCarryOwnArea("2026-08"), true, "and every month the Direct Orders module stamped");
  assert.equal(directRowsCarryOwnArea("2026-09"), true, "including every later month");
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
