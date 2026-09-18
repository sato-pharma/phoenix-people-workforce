import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import {
  buildWeeklyUnmappedWorkbook,
  parseWeeklyFilledWorkbook,
  WEEKLY_LIST_FAILED_ROWS_KEPT,
  weeklyListFailedRecord,
  type WeeklyNormalizePreview,
  type WeeklyNormalizeReferences,
  type WeeklyNormalizeSaveResult,
} from "../src/lib/sales/weekly/normalizer.ts";

// 🔴 THE WEEKLY "UPLOAD FILLED LIST" KEPT NO RECORD OF WHAT IT COULD NOT SAVE.
//
// A pick that fails (an alias already committed to another product, an area outside the branch's
// region, a hand-typed code the master does not hold) was reported once, in a notice that names only
// the first three and then moves on. Nothing recorded the rest, so a fourth failure on a long list
// could not be found again. Each parsed pick now names its sheet row, and the failures ride on the
// upload's own history record, the way the customer map import keeps its blocked rows.
//
// Judged on the EMITTED file: the real list is built, read back, filled the way a person fills it,
// then parsed.

type FailedRow = WeeklyNormalizeSaveResult["failed"][number];

const PREVIEW = {
  distributorCode: "PS",
  unknownBranches: [
    { branchColumnIndex: null, branchName: "Tanta Depot", rawBranch: "TNT", rows: 12, netQty: 340, sourceFileType: "any" },
    { branchColumnIndex: null, branchName: "Assiut Depot", rawBranch: "AST", rows: 4, netQty: 90, sourceFileType: "sales" },
  ],
  unknownProducts: [
    { aliasKind: "code", itemCode: "TEB30", itemName: "TEBOFORTIN FORTE 30TAB", rows: 7, netQty: 120 },
    { aliasKind: "code", itemCode: "OMZ20", itemName: "OMEZ 20MG", rows: 3, netQty: 40 },
    { aliasKind: "name", itemCode: "", itemName: "NEW ITEM WITH NO CODE", rows: 1, netQty: 5 },
  ],
} as unknown as WeeklyNormalizePreview;

const REFERENCES: WeeklyNormalizeReferences = {
  areas: [{ areaCode: "D14", areaName: "Tanta", regionCode: "DL1" }],
  products: [{ code: "TE", line: "CNS", name: "Tebofortin Forte", priced: true }],
  regions: [{ regionCode: "DL1", regionName: "Delta (1)" }],
};

export async function runWeeklyUnmappedListFailedRowsTests() {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load((await buildWeeklyUnmappedWorkbook(PREVIEW, REFERENCES)) as unknown as ArrayBuffer);
  const products = book.getWorksheet("Unmapped Products");
  const branches = book.getWorksheet("Unmapped Branches");
  assert.ok(products && branches, "fixture sanity: the weekly list has both answer sheets");

  // Fill it the way a person does: two products picked from the dropdown, one left blank; one branch
  // given a region and an area, the other left blank.
  products.getCell(2, 7).value = "Tebofortin Forte (TE)";
  products.getCell(4, 7).value = "Tebofortin Forte (TE)";
  branches.getCell(2, 8).value = "Delta (1) (DL1)";
  branches.getCell(2, 9).value = "Tanta (D14)";
  const parsed = await parseWeeklyFilledWorkbook(Buffer.from(await book.xlsx.writeBuffer()));

  assert.deepEqual(
    parsed.products.map((p) => `${p.alias}@${p.row}`),
    ["TEB30@2", "NEW ITEM WITH NO CODE@4"],
    "every answered product names the sheet row it came from, so a failure can say which line to fix",
  );
  assert.deepEqual(
    parsed.branches.map((b) => `${b.rawBranch}@${b.row}`),
    ["TNT@2"],
    "every answered branch names the sheet row it came from",
  );
  assert.deepEqual(
    parsed.products[0],
    { alias: "TEB30", aliasKind: "code", productCode: "TE", row: 2 },
    "the pick itself is read exactly as before: the code comes out of the dropdown label",
  );
  assert.deepEqual(
    { ...parsed.branches[0], row: undefined },
    { areaCode: "D14", branchColumnIndex: null, branchName: "Tanta Depot", rawBranch: "TNT", regionCode: "DL1", row: undefined, sourceFileType: "any" },
    "a branch pick is read exactly as before",
  );
  assert.equal(parsed.scannedRows, 5, "every listed row is still counted as read, answered or not");

  // ── HEADLINE: the failures are KEPT, all of them, in sheet order ──
  const failed: FailedRow[] = [
    { kind: "branch", label: "TNT", reason: "Area Tanta is not inside region Delta (2).", row: 2 },
    { kind: "product", label: "OMZ20", reason: 'Product "OMX" is not in the master.', row: 3 },
    { kind: "product", label: "NEW ITEM WITH NO CODE", reason: "Alias already maps to another product.", row: 4 },
    { kind: "product", label: "TEB30", reason: 'Product "TX" is not in the master.', row: 2 },
  ];
  const record = weeklyListFailedRecord(failed);
  assert.deepEqual(
    record.values.failedRows.map((f) => `${f.kind}@${f.row}`),
    ["product@2", "product@3", "product@4", "branch@2"],
    "Upload filled list must keep every failed row in its history record — the product sheet's, then the branch " +
      "sheet's, each in sheet order; before the fix the notice named three and no record held any",
  );
  assert.deepEqual(
    record.values.failedRows[3],
    { kind: "branch", label: "TNT", reason: "Area Tanta is not inside region Delta (2).", row: 2 },
    "each keeps its kind, what the row said and why it could not be saved",
  );
  assert.equal(record.values.failedRowsKept, 4, "a fourth failure is kept, not just the three the notice names");
  assert.equal(record.note, " (each listed in this record)", "the summary says the list is complete");
  assert.deepEqual(
    weeklyListFailedRecord([]),
    { note: "", values: { failedRows: [], failedRowsKept: 0 } },
    "an upload with no failures records an empty list and no note",
  );
  assert.deepEqual(
    weeklyListFailedRecord([{ kind: "product", label: "X1", reason: "Save failed." }]).values.failedRows,
    [{ kind: "product", label: "X1", reason: "Save failed." }],
    "a failure from the on-screen save, which has no file, keeps no invented row number",
  );

  // A pathological sheet is capped so the record itself always saves, and the note says it was.
  const flood: FailedRow[] = Array.from({ length: WEEKLY_LIST_FAILED_ROWS_KEPT + 7 }, (_, i) => ({
    kind: "product",
    label: `P${i}`,
    reason: "Save failed.",
    row: WEEKLY_LIST_FAILED_ROWS_KEPT + 8 - i,
  }));
  const capped = weeklyListFailedRecord(flood);
  assert.equal(capped.values.failedRows.length, WEEKLY_LIST_FAILED_ROWS_KEPT, "a flood is capped");
  assert.equal(capped.values.failedRows[0].row, 2, "the cap keeps the FIRST rows of the sheet, not the last read");
  assert.equal(capped.note, ` (the first ${WEEKLY_LIST_FAILED_ROWS_KEPT} listed in this record)`, "a capped list says so");
  const long = weeklyListFailedRecord([{ kind: "branch", label: "B".repeat(500), reason: "W".repeat(1000), row: 5 }]).values.failedRows[0];
  assert.equal(long.label.length, 200, "a runaway cell is trimmed, never dropped");
  assert.equal(long.reason.length, 400, "a runaway reason is trimmed, never dropped");

  // The wiring. saveWeeklyNormalizerMappings is where a failure is decided, and it needs the
  // database, so the source is pinned: both failures carry the row, and the upload writes the record.
  const source = readFileSync("src/lib/sales/weekly/normalizer.ts", "utf8");
  const save = source.slice(source.indexOf("export async function saveWeeklyNormalizerMappings("), source.indexOf("function errorText("));
  const pushes = save.match(/failed\.push\(\{/g) ?? [];
  assert.equal(pushes.length, 2, "fixture sanity: the save records a failure in two places");
  assert.equal(
    (save.match(/failed\.push\(\{[^\n]*\.\.\.\(mapping\.row \? \{ row: mapping\.row \} : \{\}\) \}\);/g) ?? []).length,
    pushes.length,
    "every failure the save records names the sheet row it came from",
  );
  const upload = source.slice(source.indexOf("export async function importWeeklyFilledWorkbook("));
  assert.match(upload, /await parseWeeklyFilledWorkbook\(await input\.file\.arrayBuffer\(\)\)/, "the upload reads the file through the tested parser");
  assert.match(upload, /const failedRecord = weeklyListFailedRecord\(result\.failed\);/, "the upload builds its record from the save's own failures");
  assert.match(
    upload,
    /newValues: \{[^}]*\.\.\.failedRecord\.values[^}]*source: "weekly_unmapped_list_upload"/,
    "the failed rows ride on the upload's history record",
  );
  assert.match(upload, /\$\{result\.failed\.length\} could not be saved\$\{failedRecord\.note\}/, "its summary says whether the list is complete");
}
