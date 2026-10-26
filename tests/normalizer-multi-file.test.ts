import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { groupFileParts, partLabel } from "@/lib/sales/normalizer/multi-file";
import { buildCodedWorkbook } from "@/lib/sales/normalizer/service";
import type { NormalizeResult } from "@/lib/sales/normalizer/types";
import type { NormalizePart } from "@/lib/sales/recognize";
import { decodeFileRow, encodeFileRow, labelRowText } from "@/lib/sales/sales-upload-files";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Several raw sheets of ONE distributor on the Source Normalizer.
//
// The owner, 2026-10-26: "also in normalizer make me bulk upload" — after Sales Upload took several
// sheets of one distributor at once. Before this, a distributor that sends its month as five branch
// files needed five Analyze → map → Import rounds, each filing its own batch for the month.
//
// Pinned here: sheets of the same distributor and month become ONE part (every row of each kept,
// each row still traceable to its file); sheets of different months stay one part per month; one
// sheet answers exactly as before; a part is named by its month only when the distributor has
// several; every cited row reads "<file> row <n>"; the coded sheet's Needs mapping tab names the
// file; and every route and the screen send every chosen sheet.
// ─────────────────────────────────────────────────────────────────────────────

function result(rowNumbers: number[], exceptionRows: number[] = []): NormalizeResult {
  return {
    coded: rowNumbers.map((n) => ({ rawRowNumber: n, invoiceDate: "2026-09", qty: 1, value: 10 })),
    distributorCode: "EG-HOS",
    exceptions: exceptionRows.map((n) => ({ rawRowNumber: n, reason: "brick", rawProduct: "P1", rawTerritory: "T1", rawCustomerCode: "C1" })),
    ignoredRows: [],
    blankCustomerRows: [],
    customerBrickCorrections: [],
    summary: { brickResolved: rowNumbers.length, blankCustomerSkipped: 0, fullyCoded: rowNumbers.length, ignored: 0, productResolved: rowNumbers.length, totalRows: rowNumbers.length + exceptionRows.length },
  } as unknown as NormalizeResult;
}

const part = (period: string | null, rows: number[], exceptionRows: number[] = [], code = "EG-HOS", name = "Ibnsina"): NormalizePart => ({
  distributorCode: code,
  distributorName: name,
  period,
  result: result(rows, exceptionRows),
});

function sheetsOfOneMonthBecomeOnePart() {
  const parts = groupFileParts([
    { fileName: "branch-1.xlsx", parts: [part("2026-09", [2, 3])] },
    { fileName: "branch-2.xlsx", parts: [part("2026-09", [2, 4, 5])] },
  ]);
  assert.equal(parts.length, 1, "two sheets of September are ONE part, so the month is one batch");
  assert.deepEqual(parts[0].fileNames, ["branch-1.xlsx", "branch-2.xlsx"]);
  assert.equal(parts[0].result.coded.length, 5, "every row of both sheets is kept — none dropped, none deduplicated");
  assert.deepEqual(
    parts[0].result.coded.map((r) => decodeFileRow(r.rawRowNumber)),
    [
      { fileIndex: 0, rawRowNumber: 2 }, { fileIndex: 0, rawRowNumber: 3 },
      { fileIndex: 1, rawRowNumber: 2 }, { fileIndex: 1, rawRowNumber: 4 }, { fileIndex: 1, rawRowNumber: 5 },
    ],
    "row 2 of each sheet stays two different rows, each traceable to its own file",
  );
}

function sheetsOfDifferentMonthsStayApart() {
  const parts = groupFileParts([
    { fileName: "aug.xlsx", parts: [part("2026-08", [2])] },
    { fileName: "sep-a.xlsx", parts: [part("2026-09", [2])] },
    { fileName: "sep-b.xlsx", parts: [part("2026-09", [7])] },
  ]);
  assert.deepEqual(parts.map((p) => p.period), ["2026-08", "2026-09"], "one part per month, never one month swallowing another");
  assert.deepEqual(parts.map((p) => p.fileNames), [["aug.xlsx"], ["sep-a.xlsx", "sep-b.xlsx"]]);
  assert.deepEqual(parts[1].result.coded.map((r) => decodeFileRow(r.rawRowNumber).fileIndex), [1, 2], "a row keeps its index in the WHOLE selection");
}

function oneSheetAnswersAsBefore() {
  const only = part("2026-09", [2, 3], [9]);
  const [single] = groupFileParts([{ fileName: "ibnsina.xlsx", parts: [only] }]);
  assert.equal(single.result, only.result, "one sheet's part comes back untouched — no row number is shifted");
  assert.deepEqual(single.fileNames, ["ibnsina.xlsx"]);
}

function aPartIsNamedByItsMonthOnlyWhenNeeded() {
  const sep = { distributorCode: "EG-HOS", distributorName: "Ibnsina", period: "2026-09" };
  const aug = { distributorCode: "EG-HOS", distributorName: "Ibnsina", period: "2026-08" };
  const other = { distributorCode: "EG-UCP", distributorName: "UCP", period: "2026-09" };
  assert.equal(partLabel(sep, [sep]), "", "one part needs no prefix");
  assert.equal(partLabel(sep, [sep, aug]), "Ibnsina 2026-09", "the same distributor twice is told apart by its month");
  assert.equal(partLabel(other, [sep, other]), "UCP", "different distributors are told apart by name");
}

function everyCitedRowNamesItsFile() {
  const names = ["Branch-1.xlsx", "Branch-2.xlsx"];
  const text = `Row ${encodeFileRow(1, 14)}: territory "T1" not mapped; Row ${encodeFileRow(0, 3)} too`;
  assert.equal(labelRowText(text, names), 'Branch-2.xlsx row 14: territory "T1" not mapped; Branch-1.xlsx row 3 too');
  assert.equal(labelRowText("Row 14: x", ["only.xlsx"]), "Row 14: x", "one sheet's message is left as it was");
}

async function theNeedsMappingTabNamesTheFile() {
  const names = ["branch-1.xlsx", "branch-2.xlsx"];
  const merged = groupFileParts([
    { fileName: names[0], parts: [part("2026-09", [2], [5])] },
    { fileName: names[1], parts: [part("2026-09", [2], [8])] },
  ])[0];
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await buildCodedWorkbook(merged.result, names)) as ArrayBuffer);
  const sheet = workbook.getWorksheet("Needs mapping");
  assert.ok(sheet, "the unmapped rows come down on their own tab");
  const rows = [1, 2, 3].map((r) => (sheet.getRow(r).values as unknown[]).slice(1, 4));
  assert.deepEqual(rows, [["File", "Row", "Reason"], ["branch-1.xlsx", 5, "brick"], ["branch-2.xlsx", 8, "brick"]], "each unmapped row names its file and its own row number");

  const single = new ExcelJS.Workbook();
  await single.xlsx.load((await buildCodedWorkbook(result([2], [5]), ["only.xlsx"])) as ArrayBuffer);
  assert.deepEqual((single.getWorksheet("Needs mapping")!.getRow(1).values as unknown[]).slice(1, 3), ["Row", "Reason"], "one sheet keeps the old layout");
}

function everyRouteAndTheScreenSendEverySheet() {
  for (const route of ["preview", "import", "import-validated", "download", "mappings/template"]) {
    const src = stripComments(readFileSync(`app/api/sales/normalizer/${route}/route.ts`, "utf8"));
    assert.match(src, /formFiles\(form\)/, `${route} reads every chosen sheet`);
    assert.doesNotMatch(src, /form\.get\("file"\)/, `${route} must not read only the first sheet`);
  }
  const screen = stripComments(readFileSync("src/components/sales/normalizer-workspace.tsx", "utf8"));
  assert.match(screen, /for \(const chosen of files\) f\.append\("file", chosen\)/, "the screen sends every chosen sheet");
  assert.match(screen, /\bmultiple\b/, "the file picker takes several sheets");
}

export async function runNormalizerMultiFileTests() {
  sheetsOfOneMonthBecomeOnePart();
  sheetsOfDifferentMonthsStayApart();
  oneSheetAnswersAsBefore();
  aPartIsNamedByItsMonthOnlyWhenNeeded();
  everyCitedRowNamesItsFile();
  await theNeedsMappingTabNamesTheFile();
  everyRouteAndTheScreenSendEverySheet();
}
