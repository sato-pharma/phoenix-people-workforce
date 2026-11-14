import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  pickDuplicateUploadClash,
  type DuplicateUploadCandidate,
  type StoredUploadBatch,
} from "../src/lib/sales/import-duplicate-guard.ts";
import { buildSalesImportUploadPath, parseSalesImportUploadPath } from "../src/lib/sales/sales-import-upload-path.ts";

// The same workbook under another period is refused when the file NAME and the FIGURES both match
// (owner decision, 2026-09-17), inside the save step of every monthly upload screen.
//
// Matching the name alone refused real months, two ways:
//  - Distributors export every month under one fixed name. On production, 2026-09-17, 17 non-blocked
//    batches shared their name with another month, across 5 distributors; only the IS-S pair shared
//    its figures too.
//  - A workbook over ~4 MB reaches the server under its Storage object name, which keeps only
//    [A-Za-z0-9._-]. An all-Arabic name arrives as `.xlsx`, so every month of a large Arabic
//    workbook carries the same name.
//
// Pinned by substring, never by byte window (AGENTS.md §2.1).

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

// IS-S, measured on production: one file loaded as both 2026-04 and 2026-05.
const IS_S_FILE = "Monthly_Sales_by_Client_for_SATO_PHARMA_(PAS)20260603015619.xlsx";
const IS_S_APRIL: StoredUploadBatch = {
  file_name: IS_S_FILE,
  id: "is-s-2026-04",
  period: "2026-04",
  status: "validated",
  total_qty: 3906,
  total_rows: 1141,
  total_value: 349266.46,
};
const IS_S_AGAIN_AS_MAY: DuplicateUploadCandidate = {
  fileName: IS_S_FILE,
  period: "2026-05",
  totalQty: 3906,
  totalRows: 1141,
  totalValue: 349266.46,
};

/** The name a large workbook reaches the save step under: the last segment of its upload slot. */
function nameAfterStorage(browserName: string): string {
  const path = buildSalesImportUploadPath({ caller: { hrId: "T-1" }, fileName: browserName, uploadId: randomUUID() });
  assert.ok(path && parseSalesImportUploadPath(path), `precondition: ${browserName} must mint a valid upload slot`);
  return path.split("/").pop() as string;
}

function testTwoMonthsOfALargeArabicWorkbookAreNotADuplicate() {
  const august = nameAfterStorage("مبيعات ساتو أغسطس.xlsx");
  const september = nameAfterStorage("مبيعات ساتو سبتمبر.xlsx");
  assert.equal(august, ".xlsx", "precondition: an all-Arabic name reaches the server as .xlsx");
  assert.equal(september, august, "precondition: two months of a large Arabic workbook share one name");

  const stored: StoredUploadBatch = {
    file_name: august,
    id: "august",
    period: "2026-08",
    status: "validated",
    total_qty: 11840,
    total_rows: 2310,
    total_value: 2715402.35,
  };
  assert.equal(
    pickDuplicateUploadClash([stored], { fileName: september, period: "2026-09", totalQty: 12011, totalRows: 2295, totalValue: 2799310.2 }),
    null,
    "two months of a large Arabic workbook share the name .xlsx and differ in figures: that is two months, not one file loaded twice",
  );
}

function testAFixedMonthlyNameWithNewFiguresIsNotADuplicate() {
  // The production shape: a distributor that names every month's export the same.
  const stored: StoredUploadBatch[] = ["2026-01", "2026-02", "2026-03"].map((period, index) => ({
    file_name: "customer sales.xlsx",
    id: period,
    period,
    status: "validated",
    total_qty: 180000 + index * 1000,
    total_rows: 32000 + index,
    total_value: 34000000 + index * 250000,
  }));
  assert.equal(
    pickDuplicateUploadClash(stored, { fileName: "customer sales.xlsx", period: "2026-04", totalQty: 184500, totalRows: 31870, totalValue: 35120000.5 }),
    null,
    "a new month under the distributor's usual file name must be accepted",
  );
}

function testEveryFigureMustMatch() {
  // Any one figure can repeat between two months by chance; only all three together mean the same file.
  assert.equal(
    pickDuplicateUploadClash([IS_S_APRIL], { ...IS_S_AGAIN_AS_MAY, totalValue: 351002.1 }),
    null,
    "the same name, rows and quantity with another value is another month",
  );
  assert.equal(
    pickDuplicateUploadClash([IS_S_APRIL], { ...IS_S_AGAIN_AS_MAY, totalQty: 3911 }),
    null,
    "the same name, rows and value with another quantity is another month",
  );
  assert.equal(
    pickDuplicateUploadClash([IS_S_APRIL], { ...IS_S_AGAIN_AS_MAY, totalRows: 1142 }),
    null,
    "the same name, quantity and value with another row count is another month",
  );
}

function testTheIssPairIsStillRefused() {
  const match = pickDuplicateUploadClash([IS_S_APRIL], IS_S_AGAIN_AS_MAY);
  assert.ok(match, "the same name and the same figures under another period must be refused");
  assert.equal(match.id, "is-s-2026-04", "the refusal must name the batch already holding the file");
  assert.equal(match.period, "2026-04", "the refusal must name the period already holding the file");
}

function testTheSamePeriodIsTheReplaceFlow() {
  assert.equal(
    pickDuplicateUploadClash([IS_S_APRIL], { ...IS_S_AGAIN_AS_MAY, period: "2026-04" }),
    null,
    "re-uploading a file for its own period is the replace flow, never a duplicate",
  );
}

function testTheSameFiguresUnderAnotherNameAreNotAMatch() {
  assert.equal(
    pickDuplicateUploadClash([IS_S_APRIL], { ...IS_S_AGAIN_AS_MAY, fileName: "IS-S April corrected.xlsx" }),
    null,
    "the rule is the name AND the figures: equal totals under another name do not match",
  );
}

function testRoundingNoiseStillMatches() {
  // numeric(18,6) can arrive as a string, and a float sum is only exact to its last few digits.
  const stored: StoredUploadBatch = { ...IS_S_APRIL, total_qty: "3906.000000", total_value: "349266.460000" };
  assert.ok(
    pickDuplicateUploadClash([stored], { ...IS_S_AGAIN_AS_MAY, totalQty: 3906 - 1e-9, totalValue: 349266.46 + 0.000001 }),
    "figures a millionth apart are the same figures",
  );
}

function testNeitherAnEmptySheetNorABlockedBatchMatches() {
  const empty: StoredUploadBatch = { ...IS_S_APRIL, total_qty: 0, total_rows: 0, total_value: 0 };
  assert.equal(
    pickDuplicateUploadClash([empty], { ...IS_S_AGAIN_AS_MAY, totalQty: 0, totalRows: 0, totalValue: 0 }),
    null,
    "an empty sheet is never the same month loaded twice",
  );
  assert.equal(
    pickDuplicateUploadClash([{ ...IS_S_APRIL, status: "blocked" }], IS_S_AGAIN_AS_MAY),
    null,
    "a blocked batch never became sales and never matches",
  );
}

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  const end = source.indexOf("\nexport ", start + signature.length);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

/** The expression an object-literal property is given: `key: expression,` or the shorthand `key,`. */
function propertyExpression(block: string, key: string): string | null {
  const match = block.match(new RegExp(`\\n\\s*${key}(?::\\s*([^\\n]+?))?,\\s*\\n`));
  return match ? (match[1] ?? key).trim() : null;
}

function testEverySaveStepComparesTheFiguresItStores() {
  // Since REC-008 (14 Nov 2026) the comparison runs in ONE place, `applyImportStoreRules`
  // (import-store-rules.ts), and both save steps store exactly what it compared. Two links prove it:
  // the door compares the figures it returns, and each save step hands the door the name, month and
  // row count its insert stores, and stores the door's totals.
  const door = functionBody(read("src/lib/sales/import-store-rules.ts"), "export async function applyImportStoreRules<");
  const callAt = door.indexOf("?? assertNotADuplicateUpload)({");
  assert.ok(callAt >= 0, "the one door must check for the same workbook under another period");
  const call = door.slice(callAt, door.indexOf("});", callAt));
  for (const [argument, expression] of [
    ["fileName", "input.fileName"],
    ["period", "input.period"],
    ["totalRows", "input.totalRows"],
    ["totalQty", "totals.totalQty"],
    ["totalValue", "totals.totalValue"],
  ] as const) {
    assert.equal(propertyExpression(call, argument), expression, `the door must compare ${argument} as ${expression}`);
  }
  assert.match(
    door,
    /return \{ rows, deducted, totalQty: totals\.totalQty, totalValue: totals\.totalValue \};/,
    "the door must return exactly the totals it compared",
  );

  const saves = [
    {
      file: "src/lib/sales/monthly-distributor-import.ts",
      signature: "export async function persistDistributorSalesUpload(",
      // The receipt keeps the sheet's totals when nothing was deducted — the door then returns those same totals.
      totals: /const storedTotals = stored\.deducted\s*\? \{ \.\.\.result\.totals, totalQty: stored\.totalQty, totalValue: stored\.totalValue \}\s*: result\.totals;/,
      sheetTotals: /sheetTotals: \{ totalQty: result\.totals\.totalQty, totalValue: result\.totals\.totalValue \}/,
      rowCount: null,
    },
    {
      file: "src/lib/sales/normalizer/service.ts",
      signature: "export async function persistNormalizedBatch(",
      totals: /const totalQty = stored\.totalQty;[\s\S]*const totalValue = stored\.totalValue;/,
      sheetTotals: null,
      // The door is handed the sheet's rows and returns the same number of rows (EPDA reduces a quantity,
      // never drops a row — the behaviour is exercised in tests/sales-import-one-door.test.ts).
      rowCount: { call: "sheetRows.length", insert: "rows.length", alias: "const rows = stored.rows;" },
    },
  ];
  for (const save of saves) {
    const body = functionBody(read(save.file), save.signature);
    const doorAt = body.indexOf("applyImportStoreRules(");
    assert.ok(doorAt >= 0, `${save.signature} must pass its rows through the one door`);
    const insertAt = body.indexOf(".insert(");
    assert.ok(insertAt > doorAt, `${save.signature} must check before the batch row is written`);
    const doorCall = body.slice(doorAt, body.indexOf("});", doorAt));
    const insert = body.slice(insertAt, body.indexOf("})", insertAt));
    for (const [argument, column] of [
      ["fileName", "file_name"],
      ["period", "period"],
      ["totalRows", "total_rows"],
    ] as const) {
      const passed = propertyExpression(doorCall, argument);
      assert.ok(passed, `${save.signature} must pass ${argument}`);
      const storedAs = propertyExpression(insert, column);
      if (argument === "totalRows" && save.rowCount) {
        assert.equal(passed, save.rowCount.call, `${save.signature} must count the rows it hands the door`);
        assert.equal(storedAs, save.rowCount.insert, `${save.signature} must store the count of the door's rows`);
        assert.ok(body.includes(save.rowCount.alias), `${save.signature} must store the door's rows`);
        continue;
      }
      assert.equal(passed, storedAs, `${save.signature} must compare ${argument} with exactly what the insert stores as ${column}`);
    }
    assert.match(body, save.totals, `${save.signature} must store the totals the door compared`);
    if (save.sheetTotals) assert.match(body, save.sheetTotals, `${save.signature} must hand the door the totals it would store`);
    assert.equal(body.includes("assertNotADuplicateUpload("), false, `${save.signature} must not run a second comparison of its own`);
  }
  const monthly = functionBody(read("src/lib/sales/monthly-distributor-import.ts"), "export async function persistDistributorSalesUpload(");
  assert.match(propertyExpression(monthly.slice(monthly.indexOf(".insert(")), "total_qty") ?? "", /^storedTotals\.totalQty$/);
  assert.match(propertyExpression(monthly.slice(monthly.indexOf(".insert(")), "total_value") ?? "", /^storedTotals\.totalValue$/);
  const normalizer = functionBody(read("src/lib/sales/normalizer/service.ts"), "export async function persistNormalizedBatch(");
  assert.equal(propertyExpression(normalizer.slice(normalizer.indexOf(".insert(")), "total_qty"), "Number(totalQty.toFixed(6))");
  assert.equal(propertyExpression(normalizer.slice(normalizer.indexOf(".insert(")), "total_value"), "Number(totalValue.toFixed(6))");
}

function testTheLookupReadsEveryFigureItCompares() {
  // A SELECT missing a figure turns that comparison into NaN, and NaN never matches: every duplicate
  // would pass, with no error anywhere.
  const lookup = functionBody(read("src/lib/sales/import-duplicate-guard.ts"), "export async function findDuplicateUploadBatch(");
  const select = lookup.match(/\.select\("([^"]+)"\)/);
  assert.ok(select, "the lookup must name the columns it reads");
  const columns = select[1].split(",").map((column) => column.trim());
  for (const column of ["period", "file_name", "status", "total_rows", "total_qty", "total_value"]) {
    assert.ok(columns.includes(column), `the lookup must read ${column}`);
  }
  assert.ok(lookup.includes("pickDuplicateUploadClash("), "the lookup must decide with the matcher these cases exercise");
}

function testTheCommitRouteNoLongerRefusesByNameAlone() {
  const route = read("app/api/sales/monthly-import/commit/route.ts");
  assert.ok(
    !route.includes("assertNotADuplicateUpload"),
    "the Monthly Import commit route must not refuse on the file name alone; the save step decides with the figures",
  );
  assert.ok(route.includes("importSourceOfSalesFile("), "the commit route must still save through the importer that makes the check");
}

function testTheNormalizerScreensShowTheRefusal() {
  // Without its own branch, clientSafeErrorMessage reads a workflow error that carries details as
  // infrastructure and swaps the refusal for "Failed to import." behind a 500.
  for (const file of ["app/api/sales/normalizer/import/route.ts", "app/api/sales/normalizer/import-validated/route.ts"]) {
    const route = read(file);
    assert.match(
      route,
      /if \(error instanceof SalesWorkflowError\) \{\s*return NextResponse\.json\(\{[^;]*\berror: error\.message\b[^;]*\{ status: error\.status \}\);/,
      `${file} must answer a refusal with its own message and status`,
    );
    assert.ok(
      route.indexOf("error instanceof SalesWorkflowError") < route.indexOf('clientSafeErrorMessage(error, "Failed to import.")'),
      `${file} must answer the refusal before the generic 500 can hide it`,
    );
  }
}

export function runDuplicateUploadNameAndFiguresTests() {
  testTwoMonthsOfALargeArabicWorkbookAreNotADuplicate();
  testAFixedMonthlyNameWithNewFiguresIsNotADuplicate();
  testEveryFigureMustMatch();
  testTheIssPairIsStillRefused();
  testTheSamePeriodIsTheReplaceFlow();
  testTheSameFiguresUnderAnotherNameAreNotAMatch();
  testRoundingNoiseStillMatches();
  testNeitherAnEmptySheetNorABlockedBatchMatches();
  testEverySaveStepComparesTheFiguresItStores();
  testTheLookupReadsEveryFigureItCompares();
  testTheCommitRouteNoLongerRefusesByNameAlone();
  testTheNormalizerScreensShowTheRefusal();
}
