import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  buildAreaReferencesFromRows,
  buildMonthlyClosingMatrix,
  buildRegionNameByCode,
  buildSourceOfSalesDashboard,
  filterMonthlyClosingMatrix,
  normalizeSourceOfSalesProductInput,
  validateDistributorSalesWorkbookBuffer,
  type SalesReferenceData,
} from "../src/lib/sales/monthly-distributor-import.ts";
import { SalesWorkflowError } from "../src/lib/sales/contracts.ts";

const references: SalesReferenceData = {
  distributors: [
    { code: "PS", name: "overseas" },
    { code: "IS", name: "Ibn sina" },
    { code: "IS-S", name: "Ibn Sina-Sato" },
    { code: "EP-S", name: "EPDA Pharmacies" },
  ],
  products: [
    {
      factoryPrice: 10,
      family: "CNS Family",
      familyCode: "CNS",
      line: "CNS",
      productCode: "P-A",
      productName: "Product A",
      source: "Phoenix",
    },
    {
      factoryPrice: 50,
      family: "Pedia Family",
      familyCode: "PED",
      line: "Pedia",
      productCode: "P-B",
      productName: "Product B",
      source: "Phoenix",
    },
  ],
  regions: [
    { areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" },
    { areaCode: "A2", areaName: "Area Two", regionCode: "AB", regionName: "Alex" },
  ],
  areas: [
    { areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" },
    { areaCode: "A2", areaName: "Area Two", regionCode: "AB", regionName: "Alex" },
  ],
  blocks: [
    {
      areaCode: "A1",
      areaName: "Area One",
      blockCode: "BL-1",
      blockName: "Block One",
      regionCode: "CA",
      regionName: "Cairo",
    },
  ],
  bricks: [
    {
      areaCode: "A1",
      areaName: "Area One",
      blockCode: "BL-1",
      blockName: "Block One",
      brickId: "B-1",
      brickName: "Brick One",
      regionCode: "CA",
      regionName: "Cairo",
    },
    {
      areaCode: "A2",
      areaName: "Area Two",
      blockCode: "BL-2",
      blockName: "Block Two",
      brickId: "B-2",
      brickName: "Brick Two",
      regionCode: "AB",
      regionName: "Alex",
    },
  ],
};

async function buildWorkbookBuffer(headers: string[], rows: unknown[][]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row));
  return workbook.xlsx.writeBuffer();
}

async function buildPsWorkbookBuffer(rows: unknown[][]) {
  return buildWorkbookBuffer(
    [
      "Branch",
      "Branch Name",
      "Invoice Date",
      "Qty",
      "B. Qty",
      "Value",
      "Product ID",
      "Brick ID",
      "Area ID",
      "Region ID",
      "Distrub ID",
    ],
    rows,
  );
}

async function buildIbnSinaWorkbookBuffer(rows: unknown[][]) {
  return buildWorkbookBuffer(
    [
      "old brick",
      "Quantity",
      "Item Name",
      "Net",
      "Date",
      "Free Unit",
      "type",
      "Product ID",
      "Brick ID",
      "Area ID",
      "Region ID",
      "Distrub ID",
    ],
    rows,
  );
}

async function buildSatoWorkbookBuffer(rows: unknown[][]) {
  // Ibn Sina Sato (IS-S / PAS) feed: brick column is "Brick ID", quantity is "Quantity",
  // there is NO free-unit column, and the sheet "Net" must be ignored.
  return buildWorkbookBuffer(
    [
      "Date",
      "Quantity",
      "Net",
      "Total Quantity",
      "Discount%",
      "Item Name",
      "Product ID",
      "Brick ID",
      "Area ID",
      "Region ID",
      "Distrub ID",
    ],
    rows,
  );
}

async function buildEpdaWorkbookBuffer(rows: unknown[][]) {
  // EPDA Pharmacies (EP-S): quantity is "qnt", date is "inv_date", and is_bonus marks a
  // free-goods line that must add no value and no sales quantity.
  return buildWorkbookBuffer(
    ["inv_date", "cust_code", "cust_name", "cust_address", "is_bonus", "qnt", "Discount%", "class_name", "Product ID", "Brick ID", "Area ID", "Region ID", "Distrub ID"],
    rows,
  );
}

export async function runSalesDistributorImportTests() {
  const normalizedProduct = normalizeSourceOfSalesProductInput({
    active: true,
    factoryPrice: "1,250.75",
    family: "Tebofortin",
    familyCode: " te ",
    line: "  CNS  ",
    productCode: " te009 ",
    productName: "  Tebofortin Test  ",
    source: "Marcyl",
    sourceFile: "",
    sourceRowNumber: "",
    sourceSheet: "",
  });

  assert.equal(normalizedProduct.productCode, "TE009");
  assert.equal(normalizedProduct.productName, "Tebofortin Test");
  assert.equal(normalizedProduct.familyCode, "TE");
  assert.equal(normalizedProduct.factoryPrice, 1250.75);
  assert.equal(normalizedProduct.normalizedProductName, "tebofortin test");
  assert.equal(normalizedProduct.normalizedLine, "cns");
  assert.equal(normalizedProduct.sourceFile, "Manual Entry");
  assert.equal(normalizedProduct.sourceSheet, "Products");
  assert.equal(normalizedProduct.sourceRowNumber, null);

  assert.throws(
    () => normalizeSourceOfSalesProductInput({
      factoryPrice: "-1",
      family: "Family",
      familyCode: "FA",
      line: "Line",
      productCode: "P-X",
      productName: "Product X",
      source: "Source",
    }),
    SalesWorkflowError,
  );

  const psBuffer = await buildPsWorkbookBuffer([
    ["B1", "Branch", new Date("2026-04-01T00:00:00Z"), 10, 1, 100, "P-A", "B-1", "A1", "CA", "PS"],
    ["B1", "Branch", new Date("2026-04-02T00:00:00Z"), 5, 2, 250, "P-B", "B-2", "A2", "AB", "PS"],
    ["B1", "Branch", new Date("2026-04-03T00:00:00Z"), 3, 0, 30, "P-A", "#N/A", "A1", "CA", "PS"],
  ]);

  const psResult = await validateDistributorSalesWorkbookBuffer({
    buffer: psBuffer as unknown as ArrayBuffer,
    distributorCode: "PS",
    fileName: "customer sales - Copy.XLSX",
    references,
  });

  assert.equal(psResult.templateKey, "overseas_ps");
  assert.equal(psResult.status, "blocked");
  assert.equal(psResult.rowCount, 3);
  assert.equal(psResult.failedRows, 1);
  assert.equal(psResult.totals.totalQty, 18);
  assert.equal(psResult.totals.totalBonusQty, 3);
  assert.equal(psResult.totals.totalValue, 380);
  assert.equal(psResult.period, "2026-04");
  assert.equal(psResult.byArea.find((row) => row.areaCode === "A1")?.totalQty, 13);
  assert.equal(psResult.byBrick.find((row) => row.brickId === "B-1")?.totalValue, 100);
  assert.equal(psResult.byProduct.find((row) => row.productCode === "P-A")?.officialLine, "CNS");
  assert.ok(psResult.issues.some((issue) => issue.field === "Brick ID" && issue.value === "#N/A"));

  const ibnBuffer = await buildIbnSinaWorkbookBuffer([
    ["10101", 24, "Product A", 240, "2026/04/30", 0, "#N/A", "P-A", "B-1", "A1", "CA", "IS"],
    ["10102", 2, "Product B", 100, "2026/04/29", 1, "#N/A", "P-B", "B-2", "A2", "AB", "IS"],
  ]);

  const ibnResult = await validateDistributorSalesWorkbookBuffer({
    buffer: ibnBuffer as unknown as ArrayBuffer,
    distributorCode: "IS",
    fileName: "ibnsina 4.xlsx",
    references,
  });

  assert.equal(ibnResult.templateKey, "ibn_sina_is");
  assert.equal(ibnResult.status, "validated");
  assert.equal(ibnResult.failedRows, 0);
  assert.equal(ibnResult.warningRows, 0);
  assert.equal(ibnResult.totals.totalQty, 26);
  assert.equal(ibnResult.totals.totalBonusQty, 1);
  assert.equal(ibnResult.totals.totalValue, 340);
  assert.equal(ibnResult.byLine.find((row) => row.line === "CNS")?.totalQty, 24);

  const mismatchBuffer = await buildPsWorkbookBuffer([
    ["B1", "Branch", new Date("2026-04-04T00:00:00Z"), 1, 0, 10, "P-A", "B-1", "A1", "AB", "PS"],
  ]);

  const mismatchResult = await validateDistributorSalesWorkbookBuffer({
    buffer: mismatchBuffer as unknown as ArrayBuffer,
    distributorCode: "PS",
    fileName: "customer sales - Copy.XLSX",
    references,
  });

  assert.equal(mismatchResult.status, "validated");
  assert.equal(mismatchResult.failedRows, 0);
  assert.equal(mismatchResult.warningRows, 1);
  assert.ok(mismatchResult.issues.some((issue) => issue.severity === "warning" && issue.field === "Area ID"));

  // Value must be computed as Qty x factory_price x (1 - discount), ignoring the
  // sheet Value column and the bonus units entirely.
  const discountBuffer = await buildWorkbookBuffer(
    [
      "Invoice Date",
      "Qty",
      "B. Qty",
      "Value",
      "Discount%",
      "Product ID",
      "Brick ID",
      "Area ID",
      "Region ID",
      "Distrub ID",
    ],
    [
      // Sheet Value (99999) is bogus and bonus (5) must be ignored: 10 * 10 * 0.75 = 75.
      [new Date("2026-04-01T00:00:00Z"), 10, 5, 99999, 0.25, "P-A", "B-1", "A1", "CA", "PS"],
      // Blank discount => full value: 4 * 50 = 200.
      [new Date("2026-04-02T00:00:00Z"), 4, 0, 88888, null, "P-B", "B-2", "A2", "AB", "PS"],
    ],
  );

  const discountResult = await validateDistributorSalesWorkbookBuffer({
    buffer: discountBuffer as unknown as ArrayBuffer,
    distributorCode: "PS",
    fileName: "customer sales - Copy.XLSX",
    references,
  });

  assert.equal(discountResult.status, "validated");
  assert.equal(discountResult.totals.totalQty, 14);
  assert.equal(discountResult.totals.totalBonusQty, 5);
  assert.equal(discountResult.totals.totalValue, 275);
  assert.equal(discountResult.byProduct.find((row) => row.productCode === "P-A")?.totalValue, 75);
  assert.equal(discountResult.byProduct.find((row) => row.productCode === "P-B")?.totalValue, 200);

  // Ibn Sina Sato (IS-S) feed: recognised without a free-unit column; value = Qty x price,
  // ignoring both the sheet Net and the bonus implied by Total Quantity.
  const satoBuffer = await buildSatoWorkbookBuffer([
    ["2026/04/30", 10, 99999, 12, null, "Product A", "P-A", "B-1", "A1", "CA", "IS-S"],
    ["2026/04/30", 4, 88888, 4, null, "Product B", "P-B", "B-2", "A2", "AB", "IS-S"],
  ]);

  const satoResult = await validateDistributorSalesWorkbookBuffer({
    buffer: satoBuffer as unknown as ArrayBuffer,
    distributorCode: "IS-S",
    fileName: "Monthly_Sales_by_Client_for_SATO_PHARMA_(PAS).xlsx",
    references,
  });

  assert.equal(satoResult.templateKey, "ibn_sina_sato_iss");
  assert.equal(satoResult.status, "validated");
  assert.equal(satoResult.failedRows, 0);
  assert.equal(satoResult.totals.totalQty, 14);
  assert.equal(satoResult.totals.totalBonusQty, 0); // no free-unit column
  assert.equal(satoResult.totals.totalValue, 300); // 10*10 + 4*50, Net ignored

  // EPDA Pharmacies (EP-S): recognised; value = qnt × price; the is_bonus line adds nothing.
  // The first row carries a US text date on the 1st of the month — exactly the shape
  // the EP-S system export uses. A timezone-unsafe period parse would roll "4/1/2026"
  // back to March on a host ahead of UTC and wrongly split the sheet into two months.
  const epdaBuffer = await buildEpdaWorkbookBuffer([
    ["4/1/2026", "C1", "Pharmacy A", "Addr A", 0, 10, null, "Product A", "P-A", "B-1", "A1", "CA", "EP-S"],
    [new Date("2026-04-02T00:00:00Z"), "C1", "Pharmacy A", "Addr A", 1, 5, null, "Product A", "P-A", "B-1", "A1", "CA", "EP-S"], // bonus line
    [new Date("2026-04-03T00:00:00Z"), "C2", "Pharmacy B", "Addr B", 0, 4, null, "Product B", "P-B", "B-2", "A2", "AB", "EP-S"],
  ]);
  const epdaResult = await validateDistributorSalesWorkbookBuffer({
    buffer: epdaBuffer as unknown as ArrayBuffer,
    distributorCode: "EP-S",
    fileName: "ساتو فارما صيدليات.xlsx",
    references,
  });
  assert.equal(epdaResult.templateKey, "epda_pharmacies_eps");
  assert.equal(epdaResult.status, "validated");
  assert.equal(epdaResult.period, "2026-04"); // single month: the 1st-of-month text date stays in April
  assert.deepEqual(epdaResult.blockingReasons, []); // no "multiple invoice months" block
  assert.equal(epdaResult.totals.totalQty, 19); // 10 + 5 (bonus qty still counts) + 4 = full qnt column
  assert.equal(epdaResult.totals.totalBonusQty, 5); // the bonus line's qnt, recorded for visibility
  assert.equal(epdaResult.totals.totalValue, 300); // 10*10 + 0 (free goods, 100% discount) + 4*50

  const dashboard = buildSourceOfSalesDashboard({
    availablePeriods: ["2026-04"],
    batches: [
      {
        batchId: "batch-1",
        blockingReasons: [],
        createdAt: "2026-05-01T00:00:00Z",
        distributorCode: "PS",
        distributorName: "overseas",
        failedRows: 0,
        fileName: "ps.xlsx",
        importableRows: 2,
        period: "2026-04",
        rowCount: 2,
        status: "validated",
        templateKey: "overseas_ps",
        totalBonusQty: 1,
        totalQty: 15,
        totalValue: 350,
        uploadedBy: "tester",
        warningRows: 0,
      },
      {
        batchId: "batch-2",
        blockingReasons: [],
        createdAt: "2026-05-01T00:00:00Z",
        distributorCode: "IS",
        distributorName: "Ibn sina",
        failedRows: 0,
        fileName: "is.xlsx",
        importableRows: 1,
        period: "2026-04",
        rowCount: 1,
        status: "validated",
        templateKey: "ibn_sina_is",
        totalBonusQty: 0,
        totalQty: 24,
        totalValue: 240,
        uploadedBy: "tester",
        warningRows: 0,
      },
    ],
    period: "2026-04",
    summaries: [
      {
        groupCode: null,
        groupKey: "CNS",
        groupLabel: "CNS",
        groupType: "line",
        officialLine: "CNS",
        rowCount: 3,
        totalBonusQty: 1,
        totalQty: 39,
        totalValue: 590,
      },
      {
        groupCode: "A1",
        groupKey: "A1|Area One|CA",
        groupLabel: "Area One",
        groupType: "area",
        officialLine: "CA",
        rowCount: 2,
        totalBonusQty: 1,
        totalQty: 34,
        totalValue: 340,
      },
    ],
  });

  assert.equal(dashboard.sheetCount, 2);
  assert.equal(dashboard.totals.totalQty, 39);
  assert.equal(dashboard.byDistributor.length, 2);
  assert.equal(dashboard.byLine[0]?.label, "CNS");
  assert.equal(dashboard.byArea[0]?.code, "A1");

  // Monthly Closing matrix: rows = full area master grouped by region; region subtotals
  // and the national grand total are roll-ups of the area layer (no double counting).
  const closing = buildMonthlyClosingMatrix({
    availableLines: ["CNS"],
    availablePeriods: ["2026-04"],
    line: "CNS",
    period: "2026-04",
    areas: [
      { areaCode: "A1", areaName: "Heliopolis", regionCode: "CA", regionName: "Cairo" },
      { areaCode: "A2", areaName: "Nasr City", regionCode: "CA", regionName: "Cairo" },
      { areaCode: "A4", areaName: "Zero Area", regionCode: "CA", regionName: "Cairo" },
      { areaCode: "A3", areaName: "Alex East", regionCode: "AB", regionName: "Alex" },
    ],
    products: [
      { factoryPrice: 10, family: "CNS", familyCode: "CNS", line: "CNS", productCode: "P-A", productName: "Product A", source: "Phoenix" },
      { factoryPrice: 50, family: "CNS", familyCode: "CNS", line: "CNS", productCode: "P-B", productName: "Product B", source: "Phoenix" },
    ],
    cells: [
      { areaCode: "A1", productCode: "P-A", salesUnits: 10, salesValue: 100 },
      { areaCode: "A1", productCode: "P-B", salesUnits: 5, salesValue: 50 },
      { areaCode: "A2", productCode: "P-A", salesUnits: 3, salesValue: 30 },
      { areaCode: "A3", productCode: "P-A", salesUnits: 7, salesValue: 70 },
    ],
  });

  // Columns derived from the line's products, ordered family then name.
  assert.equal(closing.columns.length, 2);
  assert.equal(closing.columns[0]?.productCode, "P-A");
  assert.equal(closing.columns[1]?.productCode, "P-B");

  // Region order is fixed (CA before AB); full area master appears, including a zero area.
  assert.equal(closing.regions[0]?.regionCode, "CA");
  assert.equal(closing.regions[1]?.regionCode, "AB");
  const caRegion = closing.regions.find((region) => region.regionCode === "CA");
  const abRegion = closing.regions.find((region) => region.regionCode === "AB");
  assert.equal(caRegion?.areas.length, 3);
  const zeroArea = caRegion?.areas.find((area) => area.areaCode === "A4");
  assert.ok(zeroArea);
  assert.equal(zeroArea?.cells[0]?.salesUnits, 0);
  assert.equal(zeroArea?.cells[0]?.salesValue, 0);

  // No double counting: per column, region subtotal == sum of its area cells,
  // and grand total == sum of ALL area cells == sum of region subtotals.
  closing.columns.forEach((_column, columnIndex) => {
    const caAreaSum = caRegion!.areas.reduce((sum, area) => sum + area.cells[columnIndex].salesUnits, 0);
    assert.equal(caRegion!.subtotal.cells[columnIndex].salesUnits, Number(caAreaSum.toFixed(6)));

    const allAreaSum = closing.regions
      .flatMap((region) => region.areas)
      .reduce((sum, area) => sum + area.cells[columnIndex].salesUnits, 0);
    const subtotalSum = closing.regions.reduce(
      (sum, region) => sum + region.subtotal.cells[columnIndex].salesUnits,
      0,
    );
    assert.equal(closing.grandTotal.cells[columnIndex].salesUnits, Number(allAreaSum.toFixed(6)));
    assert.equal(closing.grandTotal.cells[columnIndex].salesUnits, Number(subtotalSum.toFixed(6)));
  });

  // Concrete totals.
  assert.equal(caRegion?.subtotal.cells[0]?.salesUnits, 13); // A1(10) + A2(3) + A4(0)
  assert.equal(abRegion?.subtotal.cells[0]?.salesUnits, 7);
  assert.equal(closing.grandTotal.cells[0]?.salesUnits, 20); // P-A across all areas
  assert.equal(closing.grandTotal.cells[0]?.salesValue, 200);
  assert.equal(closing.grandTotal.cells[1]?.salesUnits, 5); // P-B only A1
  assert.equal(closing.grandTotal.rowTotal.salesValue, 250);

  // Phase 1: target/achievement slots stay blank.
  assert.equal(closing.grandTotal.cells[0]?.targetValue, null);
  assert.equal(closing.grandTotal.cells[0]?.achievement, null);

  // Filtering must re-derive subtotals + grand total from the surviving areas (no double count).
  const noFilter = filterMonthlyClosingMatrix(closing, {});
  assert.equal(noFilter.columns.length, 2);
  assert.equal(noFilter.grandTotal.cells[0]?.salesUnits, 20);

  // Filter to product P-A only: column dropped, totals recomputed over the single column.
  const onlyA = filterMonthlyClosingMatrix(closing, { productCodes: ["P-A"] });
  assert.equal(onlyA.columns.length, 1);
  assert.equal(onlyA.columns[0]?.productCode, "P-A");
  assert.equal(onlyA.grandTotal.cells[0]?.salesUnits, 20);

  // Filter to region CA: only CA survives; grand total == CA subtotal.
  const onlyCa = filterMonthlyClosingMatrix(closing, { regionCodes: ["CA"] });
  assert.equal(onlyCa.regions.length, 1);
  assert.equal(onlyCa.regions[0]?.regionCode, "CA");
  assert.equal(onlyCa.regions[0]?.subtotal.cells[0]?.salesUnits, 13);
  assert.equal(onlyCa.grandTotal.cells[0]?.salesUnits, 13);
  assert.equal(onlyCa.grandTotal.cells[1]?.salesUnits, 5);

  // Search "alex" keeps only Alex East (region AB).
  const searched = filterMonthlyClosingMatrix(closing, { search: "alex" });
  assert.equal(searched.regions.length, 1);
  assert.equal(searched.regions[0]?.regionCode, "AB");
  assert.equal(searched.grandTotal.cells[0]?.salesUnits, 7);

  // No double counting after filtering: grand == Σ all area cells == Σ region subtotals.
  const combo = filterMonthlyClosingMatrix(closing, { regionCodes: ["CA", "AB"], productCodes: ["P-A", "P-B"] });
  combo.columns.forEach((_column, columnIndex) => {
    const areaSum = combo.regions
      .flatMap((region) => region.areas)
      .reduce((sum, area) => sum + area.cells[columnIndex].salesUnits, 0);
    const subtotalSum = combo.regions.reduce((sum, region) => sum + region.subtotal.cells[columnIndex].salesUnits, 0);
    assert.equal(combo.grandTotal.cells[columnIndex].salesUnits, Number(areaSum.toFixed(6)));
    assert.equal(combo.grandTotal.cells[columnIndex].salesUnits, Number(subtotalSum.toFixed(6)));
  });

  // Regression: source_of_sales_areas has no `region_name` column in every Supabase
  // project (production doesn't), so the area-row mapper must join the Region NAME from the
  // regions master by code — never read it off the area row. Guards the schema-drift fix.
  const regionNameByCode = buildRegionNameByCode([
    { region_code: "CA", region_name: "Cairo" },
    { region_code: "AB", region_name: "Alex" },
    { region_code: "", region_name: "Should Be Ignored" },
  ]);
  assert.equal(regionNameByCode.get("CA"), "Cairo");
  assert.equal(regionNameByCode.get(""), undefined); // blank code is never stored

  const areaRefs = buildAreaReferencesFromRows(
    [
      // No `region_name` field at all — exactly the production areas-table shape.
      { area_code: "A1", area_name: "Area One", region_code: "CA" },
      // Lowercase / padded code still resolves via normalizeCode.
      { area_code: "A2", area_name: "Area Two", region_code: " ab " },
      // Region code with no master match → empty string, never undefined or a throw.
      { area_code: "A3", area_name: "Area Three", region_code: "ZZ" },
    ],
    regionNameByCode,
  );
  assert.equal(areaRefs[0]?.regionName, "Cairo");
  assert.equal(areaRefs[1]?.regionName, "Alex"); // " ab " normalized to "AB" before lookup
  assert.equal(areaRefs[1]?.regionCode, " ab "); // raw code is preserved as-is
  assert.equal(areaRefs[2]?.regionName, ""); // unmatched code → "" (no throw)
  assert.equal(areaRefs[2]?.areaName, "Area Three");
}
