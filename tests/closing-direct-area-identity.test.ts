import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { isSyntheticDirectArea } from "../src/lib/sales/closing-direct-area.ts";
import { JULY_2026_DIRECT_PERIOD, JULY_2026_DIRECT_ROWS } from "../src/lib/sales/july-2026-direct-orders.ts";
import { assembleComparison } from "../src/lib/sales/monthly-closing-comparison.ts";
import { buildMonthlyClosingWorkbook } from "../src/lib/sales/monthly-closing-export.ts";
import { scopeMatrixToAreaCodes } from "../src/lib/sales/monthly-closing-portal.ts";
import {
  injectDirectIntoMatrix,
  type MonthlyClosingCell,
  type MonthlyClosingDirectCell,
  type MonthlyClosingMatrix,
} from "../src/lib/sales/monthly-distributor-import.ts";

// An area that carries direct sales must keep its OWN identity.
//
// THE BUG THIS PINS. `isDirect` on an area row answers two different questions — "is this the
// synthetic 'Direct orders (company)' pseudo-area?" and "does this row contain direct money?" —
// and until 2026-08-06 they were the same question, because July's direct was REGION-grained and
// the only row that ever carried direct was the anonymous company row the injector invents.
//
// That day July's Anti-Infective direct was restated to AREA grain (16 owner-mapped rows, 2,120
// units / 149,288.50 EGP), so real areas started absorbing direct money. Every consumer reading
// the raw flag then answered the wrong question. On screen and in the workbook, Dakahlia 1 /
// Dakahlia 2 / Dakahlia 3 / Port Said-Domiat and Behira 2 all lost their code and name and
// rendered as four indistinguishable "◆ DIRECT — Direct orders (company)" rows; the values were
// right, so nothing looked broken until the owner tried to tell them apart.
//
// The identity loss was the visible half. The silent half was worse: every `!area.isDirect` filter
// dropped those same real areas — out of the area picker, out of a District Manager's own seat
// scope (scopeMatrixToAreaCodes), and out of the area codes a filtered portal export sends to the
// server, which deleted their rows from the downloaded workbook outright.
//
// Anti Infective is the sharpest case: all 16 of its mapped rows carry an area, so the line has NO
// legitimate company Direct row in July at all. Every anonymous row the owner saw was a real area.

const LINE = "Anti Infective";
const AI_ROWS = JULY_2026_DIRECT_ROWS.filter((row) => row.line === LINE);

/** The owner's live figures for the reported row, from phx_monthly_closing_matrix + the overlay. */
const D21_RETAIL = { RO001: { units: 29, value: 1_761.75 }, SA001: { units: 87, value: 9_670.05 } };
const D21_EXPECTED_TOTAL = 21_331.80; // retail 11,431.80 + overlay direct 9,900 (Saginko 100 u)

function cell(salesUnits: number, salesValue: number): MonthlyClosingCell {
  return { achievement: null, salesUnits, salesValue, targetUnits: null, targetValue: null };
}

const PRODUCTS = [
  { family: "Anti-Infective", productCode: "RO001", productName: "Royafloxacin" },
  { family: "Anti-Infective", productCode: "SA001", productName: "Saginko" },
];

/**
 * A July 2026 Anti-Infective retail matrix carrying every area the overlay names, so the merge has
 * a real row to land on. Only D21 gets the owner's live retail figures — the rest carry a token
 * amount, which is enough for the identity assertions and keeps the arithmetic checkable by hand.
 */
function retailMatrix(): MonthlyClosingMatrix {
  const byRegion = new Map<string, Map<string, string>>();
  AI_ROWS.forEach((row) => {
    let areas = byRegion.get(row.regionCode);
    if (!areas) { areas = new Map(); byRegion.set(row.regionCode, areas); }
    areas.set(row.areaCode, row.areaName);
  });

  const regions = [...byRegion.entries()].map(([regionCode, areas]) => {
    const areaRows = [...areas.entries()].map(([areaCode, areaName]) => {
      const cells = areaCode === "D21"
        ? [cell(D21_RETAIL.RO001.units, D21_RETAIL.RO001.value), cell(D21_RETAIL.SA001.units, D21_RETAIL.SA001.value)]
        : [cell(1, 10), cell(1, 10)];
      return {
        areaCode,
        areaName,
        cells,
        kind: "area" as const,
        regionCode,
        regionName: `Region ${regionCode}`,
        rowTotal: cell(
          cells.reduce((sum, c) => sum + c.salesUnits, 0),
          cells.reduce((sum, c) => sum + c.salesValue, 0),
        ),
      };
    });
    const subtotalCells = PRODUCTS.map((_p, index) =>
      cell(
        areaRows.reduce((sum, area) => sum + area.cells[index]!.salesUnits, 0),
        areaRows.reduce((sum, area) => sum + area.cells[index]!.salesValue, 0),
      ));
    return {
      areas: areaRows,
      regionCode,
      regionName: `Region ${regionCode}`,
      subtotal: {
        cells: subtotalCells,
        kind: "regionSubtotal" as const,
        regionCode,
        regionName: `Region ${regionCode}`,
        rowTotal: cell(
          subtotalCells.reduce((sum, c) => sum + c.salesUnits, 0),
          subtotalCells.reduce((sum, c) => sum + c.salesValue, 0),
        ),
      },
    };
  });

  const grandCells = PRODUCTS.map((_p, index) =>
    cell(
      regions.reduce((sum, region) => sum + region.subtotal.cells[index]!.salesUnits, 0),
      regions.reduce((sum, region) => sum + region.subtotal.cells[index]!.salesValue, 0),
    ));

  return {
    availableLines: [LINE],
    availablePeriods: [JULY_2026_DIRECT_PERIOD],
    columns: PRODUCTS,
    grandTotal: {
      cells: grandCells,
      kind: "grandTotal",
      rowTotal: cell(
        grandCells.reduce((sum, c) => sum + c.salesUnits, 0),
        grandCells.reduce((sum, c) => sum + c.salesValue, 0),
      ),
    },
    line: LINE,
    period: JULY_2026_DIRECT_PERIOD,
    regions,
  } as unknown as MonthlyClosingMatrix;
}

/**
 * The direct RPC's own answer for the month, aggregated to (region, product) exactly as the live
 * one is. resolveJulyDirectByArea refuses to merge unless this reconciles with the overlay to the
 * piastre, so deriving both from the same rows is what keeps the merge switched on here.
 */
function directCells(): MonthlyClosingDirectCell[] {
  const byKey = new Map<string, MonthlyClosingDirectCell>();
  AI_ROWS.forEach((row) => {
    const key = `${row.regionCode}|${row.productCode}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.salesUnits += row.qty;
      existing.salesValue += row.value;
      return;
    }
    byKey.set(key, {
      productCode: row.productCode,
      regionCode: row.regionCode,
      salesUnits: row.qty,
      salesValue: row.value,
    } as MonthlyClosingDirectCell);
  });
  return [...byKey.values()];
}

function areaByCode(matrix: MonthlyClosingMatrix, areaCode: string) {
  return matrix.regions.flatMap((region) => region.areas).find((area) => area.areaCode === areaCode);
}

function comparisonFor() {
  const areaMeta = AI_ROWS.map((row) => ({ areaCode: row.areaCode, areaName: row.areaName, regionCode: row.regionCode }));
  return assembleComparison({
    brickRows: [],
    customerRows: [],
    distProductRows: [],
    line: LINE,
    maps: {
      areaName: new Map(areaMeta.map((area) => [area.areaCode, area.areaName])),
      areaRegion: new Map(areaMeta.map((area) => [area.areaCode, area.regionCode])),
      distributorName: new Map(),
      regionName: new Map(areaMeta.map((area) => [area.regionCode, `Region ${area.regionCode}`])),
    },
    masterAreas: areaMeta,
    masterBricks: [],
    period: JULY_2026_DIRECT_PERIOD,
  });
}

/** Every string in one worksheet's first two columns — the code and name of each row. */
async function sheetLabels(buffer: ArrayBuffer, sheetName: string): Promise<string[]> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  const sheet = book.getWorksheet(sheetName);
  assert.ok(sheet, `the workbook has a "${sheetName}" sheet`);
  const labels: string[] = [];
  sheet!.eachRow((row) => {
    [1, 2].forEach((column) => {
      const text = row.getCell(column).text;
      if (typeof text === "string" && text.trim()) labels.push(text.trim());
    });
  });
  return labels;
}

export async function runClosingDirectAreaIdentityTests() {
  // The overlay is the reconciliation anchor: if it ever drifts from the figures the owner signed
  // off, the merge silently switches off and every assertion below would pass for the wrong reason.
  assert.equal(AI_ROWS.length, 16, "July Anti-Infective carries the owner's 16-row area mapping");
  assert.equal(
    AI_ROWS.reduce((sum, row) => sum + row.qty, 0),
    2_120,
    "July Anti-Infective direct is 2,120 units — the total the closing reconciles against",
  );
  assert.equal(
    Number(AI_ROWS.reduce((sum, row) => sum + row.value, 0).toFixed(2)),
    149_288.50,
    "July Anti-Infective direct is EGP 149,288.50",
  );
  assert.ok(
    AI_ROWS.every((row) => row.areaCode.trim() !== ""),
    "every Anti-Infective row carries an area, so the line has no legitimate company Direct row in July",
  );

  const merged = injectDirectIntoMatrix(retailMatrix(), directCells());
  const d21 = areaByCode(merged, "D21");
  assert.ok(d21, "the merge kept a row for D21 rather than replacing it with a company Direct row");

  // ── THE HEADLINE. A real area that absorbed direct is NOT the company row. ──────────────────
  assert.equal(
    isSyntheticDirectArea(d21!),
    false,
    "D21 absorbed direct money but is still Dakahlia 1 — it must never be read as the synthetic company row",
  );
  assert.equal(d21!.areaCode, "D21", "D21 keeps its own area code");
  assert.equal(d21!.areaName, "Dakahlia 1", "D21 keeps its own area name");
  assert.equal(
    d21!.isDirect,
    true,
    "…while isDirect stays true: it answers the OTHER question (this row contains direct money) and drives static export rendering",
  );

  // Values are untouched by any of this — retail 11,431.80 + the overlay's Saginko 100 u / 9,900.
  assert.equal(Number(d21!.rowTotal.salesValue.toFixed(2)), D21_EXPECTED_TOTAL, "D21 totals EGP 21,331.80");
  assert.equal(d21!.rowTotal.salesUnits, 216, "D21 totals 216 units (116 retail + 100 direct)");
  assert.equal(
    Number(d21!.cells[1]!.salesValue.toFixed(2)),
    19_570.05,
    "D21 Saginko = 9,670.05 retail + 9,900 direct",
  );
  assert.equal(
    Number(d21!.cells[0]!.salesValue.toFixed(2)),
    D21_RETAIL.RO001.value,
    "D21 Royafloxacin took no direct and is unchanged",
  );

  // Each of the four Delta (2) areas the owner listed stays individually identifiable.
  ["D21", "D22", "D23", "D26", "AB5"].forEach((areaCode) => {
    const area = areaByCode(merged, areaCode);
    assert.ok(area, `${areaCode} survives the merge as its own row`);
    assert.equal(
      isSyntheticDirectArea(area!),
      false,
      `${areaCode} carries direct money but keeps its own identity, not "Direct orders (company)"`,
    );
  });
  const names = merged.regions.flatMap((region) => region.areas.map((area) => area.areaName));
  assert.equal(
    new Set(names).size,
    names.length,
    "no two area rows share a name — four anonymous 'Direct orders (company)' rows was the bug",
  );

  // ── The synthetic row still behaves as the company row. ────────────────────────────────────
  assert.equal(
    isSyntheticDirectArea({ areaCode: "DIRECT", isDirect: true }),
    true,
    "the injector's synthetic pseudo-area IS the company row",
  );
  assert.equal(
    isSyntheticDirectArea({ areaCode: "DIRECT", isDirect: false }),
    false,
    "a real area coded DIRECT without the flag is not the synthetic row",
  );
  assert.equal(
    isSyntheticDirectArea({ areaCode: "D21", isDirect: true }),
    false,
    "carrying direct money is not what makes a row the company row",
  );

  // ── The silent half: a District Manager must still see their own area. ─────────────────────
  const dmScoped = scopeMatrixToAreaCodes(merged, new Set(["D21"]));
  assert.deepEqual(
    dmScoped.regions.flatMap((region) => region.areas.map((area) => area.areaCode)),
    ["D21"],
    "the D21 District Manager still sees Dakahlia 1 — reading the raw isDirect flag dropped their own area out of their seat scope",
  );
  assert.equal(
    Number(dmScoped.grandTotal.rowTotal.salesValue.toFixed(2)),
    D21_EXPECTED_TOTAL,
    "and their scoped total is still the full 21,331.80, direct included",
  );

  // ── The workbook: both sheets that name a row must name the area, not the company. ─────────
  const buffer = (await buildMonthlyClosingWorkbook(merged, comparisonFor())) as unknown as ArrayBuffer;
  for (const sheetName of ["Closing Matrix", "Target vs Achievement"]) {
    const labels = await sheetLabels(buffer, sheetName);
    assert.ok(
      labels.includes("Dakahlia 1"),
      `the ${sheetName} sheet names Dakahlia 1 rather than anonymising it`,
    );
    assert.equal(
      labels.filter((label) => label === "Direct orders (company)").length,
      0,
      `the ${sheetName} sheet has no company Direct row in July Anti-Infective — every direct row there belongs to a real area`,
    );
  }
}
