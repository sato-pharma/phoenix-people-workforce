import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { assembleComparison } from "../src/lib/sales/monthly-closing-comparison.ts";
import {
  buildFilterOptions,
  summarize,
  type ClosingDetailRow,
  type ClosingDetailsResult,
} from "../src/lib/sales/monthly-closing-details.ts";
import { buildMonthlyClosingWorkbook } from "../src/lib/sales/monthly-closing-export.ts";
import {
  buildMonthlyClosingMatrix,
  rebuildMatrixFromRows,
  type MonthlyClosingMatrix,
} from "../src/lib/sales/monthly-distributor-import.ts";

// A ROW-LEVEL FILTERED admin export whose slice contains DIRECT money must still show that money.
//
// THE BUG THIS PINS. `rowLevelActive` (a distributor, Included/Excluded, or free-text filter) makes
// the route rebuild the Closing Matrix from the filtered invoice rows. Every direct row arrives
// `includedInClosing: false`, so the rebuild dropped them — correct for "Distributor = PS", because
// direct orders have no distributor, but NOT for the slice that is nothing BUT direct:
//
//   `DIRECT` is itself a selectable distributor. Production 2026-07 carries 51 such rows worth
//   1,208,548.15 EGP, and buildFilterOptions offers every distributorCode it sees.
//
// So "Distributor = DIRECT" produced a Closing Matrix of ZEROS beside a Data sheet listing all 51
// rows. Worse, it looked healthy: `channels` is null under a row-level filter, so the Total sheet's
// direct bridge fell back to zero too, and Difference read 0 — zero against zero. Nothing on any
// sheet said the money existed.
//
// WHAT IS ASSERTED. The real workbook is built and read back: the matrix carries the direct money,
// the Total sheet NAMES it on its own reconciliation line, and the reconciliation block still adds
// up. The route itself is an HTTP handler that loads from Supabase, so this exercises the exact
// domain calls it makes — rebuildMatrixFromRows with `includeDirect` plus the derived
// `directPlaced` — in the same order.

const LINE = "Pedia";
const PERIOD = "2026-07";
const PRODUCT = "IV001";
const AREA = "GZ7";
const AREA_NAME = "October - Zayed";

function matrix(): MonthlyClosingMatrix {
  return buildMonthlyClosingMatrix({
    areas: [{ areaCode: AREA, areaName: AREA_NAME, regionCode: "GZ", regionName: "Giza" }],
    availableLines: [LINE],
    availablePeriods: [PERIOD],
    // The aggregate matrix for the month. Under a row-level filter the route replaces these cells
    // wholesale, so the figures here only have to exist.
    cells: [{ areaCode: AREA, productCode: PRODUCT, salesUnits: 4000, salesValue: 90000 }],
    line: LINE,
    period: PERIOD,
    products: [{
      factoryPrice: 14, family: "F", familyCode: "F", line: LINE,
      productCode: PRODUCT, productName: "Ivyronc", source: "",
    }],
  });
}

/** A direct row exactly as loadMonthlyClosingDetails returns one: never in closing, flagged
 *  isDirect, distributor "DIRECT", carrying the FACT area the closing books against. */
function directRow(id: number, qty: number, salesValue: number): ClosingDetailRow {
  return {
    areaCode: AREA,
    areaName: AREA_NAME,
    blockCode: "",
    brickId: "",
    brickName: "",
    clientAddress: "",
    clientCode: "",
    clientName: "",
    distributorCode: "DIRECT",
    effectiveUnits: qty,
    factoryPrice: 14,
    id,
    includedInClosing: false,
    invoiceDate: null,
    invoicePeriod: PERIOD,
    isConfidential: false,
    isDirect: true,
    officialLine: LINE,
    productCode: PRODUCT,
    productName: "Ivyronc",
    qty,
    regionCode: "GZ",
    regionName: "Giza",
    rowNumber: id,
    salesValue,
    sheetAreaCode: AREA,
    sheetAreaName: AREA_NAME,
    sheetRegionCode: "GZ",
    sheetRegionName: "Giza",
    exclusions: ["direct"],
  } as unknown as ClosingDetailRow;
}

function detailsOf(rows: ClosingDetailRow[]): ClosingDetailsResult {
  return {
    canRevealConfidential: false,
    confidentialIncluded: false,
    filteredRowCount: rows.length,
    line: LINE,
    options: buildFilterOptions(rows),
    outOfScope: false,
    page: 1,
    pageSize: rows.length,
    period: PERIOD,
    reconciliation: {
      areaMismatches: summarize(rows, (row) => row.areaMismatch),
      excludedConfidential: summarize(rows, (row) => row.isConfidential),
      excludedDirect: summarize(rows, (row) => row.isDirect),
      includedInClosing: summarize(rows, (row) => row.includedInClosing),
      missingClientCode: summarize(rows, (row) => row.missingClientCode),
      unmappedBricks: summarize(rows, (row) => row.brickUnmapped),
    },
    rows,
    totals: summarize(rows, () => true),
  } as unknown as ClosingDetailsResult;
}

/** The audit pair's comparison. Direct rows carry no distributor invoice identity, so the leaves
 *  are thin on purpose — the sheets under test here are the Matrix and the Total. */
function comparisonOf(rows: ClosingDetailRow[]) {
  const leaf = (row: ClosingDetailRow) => ({
    areaCode: row.areaCode, brickId: row.brickId, distributorCode: row.distributorCode,
    regionCode: row.regionCode, units: row.qty, value: row.salesValue,
  });
  return assembleComparison({
    brickRows: rows.map(leaf),
    customerRows: rows.map((row) => ({ ...leaf(row), clientCode: row.clientCode, clientName: row.clientName })),
    distProductRows: rows.map((row) => ({
      ...leaf(row), productCode: row.productCode, productName: row.productName,
    })),
    line: LINE,
    maps: {
      areaName: new Map([[AREA, AREA_NAME]]),
      areaRegion: new Map([[AREA, "GZ"]]),
      distributorName: new Map([["DIRECT", "Direct orders (company)"], ["PS", "Pharma Serve"]]),
      regionName: new Map([["GZ", "Giza"]]),
    },
    masterAreas: [{ areaCode: AREA, areaName: AREA_NAME, regionCode: "GZ" }],
    masterBricks: [{ areaCode: AREA, brickId: `B-${AREA}`, brickName: `${AREA} brick`, regionCode: "GZ" }],
    period: PERIOD,
  });
}

/**
 * The route's row-level-filtered path, in the order route.ts runs it. `includeDirect` decides
 * whether the slice keeps its direct money; `directPlaced` is derived as (with) minus (without),
 * never by summing the rows, so a direct row for an area outside this matrix — never placed in a
 * cell — is not bridged as though it were on the sheet.
 */
async function filteredExport(rows: ClosingDetailRow[], includeDirect: boolean) {
  const details = detailsOf(rows);
  const base = matrix();
  const rebuilt = rebuildMatrixFromRows(base, rows, includeDirect ? { includeDirect: true } : undefined);
  const invoiceOnly = rebuildMatrixFromRows(base, rows);
  const directPlaced = {
    units: rebuilt.grandTotal.cells.reduce((sum, cell) => sum + cell.salesUnits, 0)
      - invoiceOnly.grandTotal.cells.reduce((sum, cell) => sum + cell.salesUnits, 0),
    value: rebuilt.grandTotal.rowTotal.salesValue - invoiceOnly.grandTotal.rowTotal.salesValue,
  };
  const buffer = await buildMonthlyClosingWorkbook(
    rebuilt,
    comparisonOf(rows),
    details,
    {
      // `channels` is null on this path — that is what made the bridge fall back to zero.
      channels: null,
      directPlaced,
      filterNote: "Filtered export — Distributor: DIRECT.",
      includeTargetSheet: false,
    },
  );
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as unknown as ArrayBuffer);
  return { book, directPlaced, rebuilt };
}

/** One cell of a labelled reconciliation row on the Total sheet, read back out of the real file.
 *  A formula caching exactly zero comes back without a result — ExcelJS drops a falsy cached
 *  value on write — so null means "a formula that caches zero", never "the row is missing". */
function reconciliationCell(book: ExcelJS.Workbook, startsWith: string, column: number): number | null {
  const sheet = book.getWorksheet("Total");
  assert.ok(sheet, "the workbook has a Total sheet");
  let found: number | null = null;
  sheet.eachRow((row) => {
    if (!String(row.getCell(1).value ?? "").startsWith(startsWith)) return;
    const raw = row.getCell(column).value;
    const value = raw && typeof raw === "object" && "result" in raw ? (raw as { result?: number }).result : raw;
    found = typeof value === "number" ? value : null;
  });
  return found;
}

export async function runClosingFilteredExportKeepsDirectTests() {
  // The owner's own July figures, at the 14 EGP unit price he set: October-Zayed 1,000 units /
  // 14,000.00 plus a second direct row, so the assertion cannot pass on a single-row coincidence.
  const rows = [directRow(1, 1000, 14000), directRow(2, 500, 7000)];

  const { book, directPlaced, rebuilt } = await filteredExport(rows, true);

  // 1. The matrix carries the money. This is the assertion that fails without `includeDirect`.
  assert.equal(
    rebuilt.grandTotal.rowTotal.salesValue,
    21000,
    "a Distributor = DIRECT slice must carry its direct money (14,000 + 7,000) — a matrix of zeros "
      + "beside a Data sheet full of rows is the bug",
  );
  assert.equal(rebuilt.grandTotal.cells.reduce((sum, cell) => sum + cell.salesUnits, 0), 1500);

  // 2. It is NAMED on the Total sheet rather than merely present. The owner's standing rule: money
  //    that moved or is missing never renders as an unexplained absence.
  assert.equal(directPlaced.value, 21000, "the bridge states the direct money, not zero");
  assert.equal(
    reconciliationCell(book, "+ Direct orders counted in the matrix", 3),
    21000,
    "the Total sheet must carry a '+ Direct orders counted in the matrix' line naming the value — "
      + "with the bridge at its zero default this row was omitted entirely",
  );
  assert.equal(reconciliationCell(book, "+ Direct orders counted in the matrix", 2), 1500, "…and its units");

  // 3. The reconciliation still adds up: Data rows (zero — direct never arrives as an invoice) plus
  //    the direct bridge must reproduce the headline.
  const headline = reconciliationCell(book, "Closing Matrix grand total", 3) ?? 0;
  assert.equal(headline, 21000, "the headline is the filtered matrix in this workbook");
  const dataLine = reconciliationCell(book, "Data sheet —", 3) ?? 0;
  assert.equal(
    dataLine + 21000 - headline,
    0,
    "Data rows + direct − headline must be exactly zero, or the audit pair stops proving anything",
  );

  // 4. A real distributor's slice is UNAFFECTED — it holds no direct rows, so nothing is folded in
  //    and the invoice-only contract that path depends on still stands.
  const invoiceRows = [{ ...directRow(3, 40, 560), distributorCode: "PS", includedInClosing: true, isDirect: false }];
  const plain = rebuildMatrixFromRows(matrix(), invoiceRows as ClosingDetailRow[], { includeDirect: true });
  assert.equal(
    plain.grandTotal.rowTotal.salesValue,
    560,
    "an ordinary distributor slice is unchanged by includeDirect — it carries no direct rows to fold",
  );
}
