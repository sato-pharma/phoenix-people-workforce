import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  MAX_UPLOAD_FILES,
  ROW_FILE_STRIDE,
  combineMonthReports,
  combinedFileName,
  decodeFileRow,
  encodeFileRow,
  findRepeatedSheet,
  labelPreviewRows,
  labelReportRows,
  mergeNormalizeResults,
  planUploadFiles,
  type LabelledFinding,
} from "../src/lib/sales/sales-upload-files.ts";
import type { NormalizeResult } from "../src/lib/sales/normalizer/types.ts";
import type { NormalizePreview } from "../src/lib/sales/recognize.ts";
import type { ValidationReport } from "../src/lib/sales/upload-validation.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Several sheets of ONE distributor, validated once and confirmed once.
//
// The owner, 2026-10-26: choose five or six sheets of the same distributor and validate them once,
// on the single-distributor upload and in bulk import alike. Before this, each file needed its own
// verify → validate → confirm, and each confirm superseded the distributor's earlier batch for that
// month — so the second branch file REPLACED the first and only one file per month survived.
//
// Pinned here: every row of every file is kept and stays traceable to its file; files of one month
// become one batch and files of different months one batch each; a picked month never swallows
// another month's files; the same sheet twice is refused (a double count is one of the two blocks);
// every cited row reads "<file> row <n>"; and the screen sends every chosen file.
// ─────────────────────────────────────────────────────────────────────────────

type Row = { rawRowNumber: number; invoiceDate: string };

function result(rows: Row[], extra: Partial<NormalizeResult> = {}): NormalizeResult {
  return {
    coded: rows,
    distributorCode: "EG-HOS",
    exceptions: [],
    ignoredRows: [],
    blankCustomerRows: [],
    customerBrickCorrections: [],
    summary: { brickResolved: rows.length, blankCustomerSkipped: 0, fullyCoded: rows.length, ignored: 0, productResolved: rows.length, totalRows: rows.length },
    ...extra,
  } as unknown as NormalizeResult;
}

const report = (findings: ValidationReport["findings"]): ValidationReport => ({
  ok: !findings.some((f) => f.severity === "error"),
  errorCount: findings.filter((f) => f.severity === "error").length,
  warningCount: findings.filter((f) => f.severity === "warning").length,
  infoCount: findings.filter((f) => f.severity === "info").length,
  findings,
});

export function runSalesUploadMultiFileTests(): void {
  // 1. Row numbers: each file in its own block, and back again.
  assert.equal(encodeFileRow(0, 14), 14, "the first file keeps its own row numbers");
  assert.equal(encodeFileRow(2, 14), 2 * ROW_FILE_STRIDE + 14);
  assert.deepEqual(decodeFileRow(encodeFileRow(3, 1_048_576)), { fileIndex: 3, rawRowNumber: 1_048_576 }, "the last Excel row of file 4 decodes to itself, never into file 5");
  assert.ok(ROW_FILE_STRIDE > 1_048_576, "a block is bigger than any Excel sheet");

  // 2. Merge: every row of every file kept, nothing deduplicated, summaries summed.
  const branchA = result([{ rawRowNumber: 2, invoiceDate: "2026-09-03" }, { rawRowNumber: 3, invoiceDate: "2026-09-04" }], {
    customerBrickCorrections: [{ distributorCode: "EG-HOS", customerCode: "C1", brickId: "B-OLD" }] as unknown as NormalizeResult["customerBrickCorrections"],
  });
  const branchB = result([{ rawRowNumber: 2, invoiceDate: "2026-09-03" }], {
    customerBrickCorrections: [{ distributorCode: "EG-HOS", customerCode: "C1", brickId: "B-NEW" }] as unknown as NormalizeResult["customerBrickCorrections"],
  });
  const merged = mergeNormalizeResults("EG-HOS", [{ fileIndex: 0, result: branchA }, { fileIndex: 1, result: branchB }]);
  assert.equal(merged.coded.length, 3, "no row is dropped — even one identical to another file's row (the duplicate check, not the merge, judges it)");
  assert.deepEqual(merged.coded.map((r) => r.rawRowNumber), [2, 3, ROW_FILE_STRIDE + 2], "file 2's row 2 stays distinguishable from file 1's row 2");
  assert.equal(merged.summary.totalRows, 3);
  assert.equal(merged.summary.fullyCoded, 3);
  assert.equal(merged.customerBrickCorrections.length, 1, "one correction per customer");
  assert.equal((merged.customerBrickCorrections[0] as unknown as { brickId: string }).brickId, "B-NEW", "the later file's correction wins, as the later row does within one file");

  // 3. Plan: which batch each file lands in.
  const sep = (name: string) => ({ fileName: name, months: ["2026-09"], dominantMonth: "2026-09" });
  const aug = (name: string) => ({ fileName: name, months: ["2026-08"], dominantMonth: "2026-08" });
  const sameMonth = planUploadFiles([sep("a.xlsx"), sep("b.xlsx"), sep("c.xlsx")], "");
  assert.ok(sameMonth.ok);
  assert.equal(sameMonth.groups.length, 1, "three files of September are ONE batch — the second never supersedes the first");
  assert.deepEqual(sameMonth.groups[0].members, [0, 1, 2]);
  assert.deepEqual(sameMonth.groups[0].decision, { kind: "ok", period: "2026-09", consolidate: false });

  const twoMonths = planUploadFiles([sep("a.xlsx"), aug("b.xlsx"), sep("c.xlsx")], "");
  assert.ok(twoMonths.ok);
  assert.deepEqual(twoMonths.groups.map((g) => [g.decision.kind === "ok" ? g.decision.period : g.decision.kind, g.members]), [["2026-08", [1]], ["2026-09", [0, 2]]], "one batch per month, in month order");

  const picked = planUploadFiles([sep("a.xlsx"), aug("b.xlsx")], "2026-09");
  assert.equal(picked.ok, false, "a picked month never swallows another month's file");
  assert.ok(!picked.ok && picked.message.includes("b.xlsx") && picked.message.includes("2026-08"), "the refusal names the file and its month");
  const pickedSame = planUploadFiles([sep("a.xlsx"), { fileName: "b.xlsx", months: ["2026-08", "2026-09"], dominantMonth: "2026-09" }], "2026-09");
  assert.ok(pickedSame.ok && pickedSame.groups.length === 1, "a picked month still takes a file whose stray rows fall in a neighbouring month");
  assert.deepEqual(pickedSame.ok && pickedSame.groups[0].decision, { kind: "ok", period: "2026-09", consolidate: true });

  const undated = planUploadFiles([sep("a.xlsx"), { fileName: "b.xlsx", months: [], dominantMonth: null }], "");
  assert.ok(undated.ok && undated.groups.length === 1 && undated.groups[0].decision.kind === "missing", "a date-less file is never folded into its neighbours' month");
  const spanning = planUploadFiles([sep("a.xlsx"), { fileName: "b.xlsx", months: ["2026-08", "2026-09"], dominantMonth: "2026-09" }], "");
  assert.ok(spanning.ok && spanning.groups[0].decision.kind === "multi", "a file spanning months asks for the month, as one file does");

  // 4. The same sheet twice is a double count, and refused.
  const fp = (fileName: string, digest: string, rows = 40, qty = 120.5, value = 9_000.25) => ({ fileName, digest, rows, qty, value });
  assert.equal(findRepeatedSheet([fp("a.xlsx", "d1"), fp("b.xlsx", "d2", 41)]), null, "different sheets pass");
  assert.match(findRepeatedSheet([fp("a.xlsx", "d1"), fp("b.xlsx", "d2", 41), fp("a copy.xlsx", "d1")]) ?? "", /"a\.xlsx" and "a copy\.xlsx" are the same file/);
  assert.match(findRepeatedSheet([fp("a.xlsx", "d1"), fp("resaved.xlsx", "d9")]) ?? "", /carry the same 40 rows, quantity and value/, "a re-saved copy (new bytes, same rows) is caught too");
  assert.equal(findRepeatedSheet([fp("a.xlsx", "d1", 0, 0, 0), fp("b.xlsx", "d2", 0, 0, 0)]), null, "two empty sheets are not a double count");

  // 5. Every cited row reads "<file> row <n>", in the detail text too.
  const names = ["branch-1.xlsx", "branch-2.xlsx"];
  assert.equal(combinedFileName(names), "branch-1.xlsx + branch-2.xlsx", "the batch is stored under every file's name");
  const cited = report([{
    code: "row_value_mismatch",
    severity: "warning",
    title: "Value does not match",
    detail: `Row ${encodeFileRow(1, 145)}: quantity times price is not the value. Row 9: the same.`,
    count: 2,
    sampleRows: [encodeFileRow(1, 145), 9],
  }]);
  const labelled = labelReportRows(cited, names).findings[0] as LabelledFinding;
  assert.deepEqual(labelled.sampleRows, [145, 9], "rows go back to each file's own numbers");
  assert.deepEqual(labelled.sampleRowLabels, ["branch-2.xlsx row 145", "branch-1.xlsx row 9"]);
  assert.equal(labelled.detail, "Branch-2.xlsx row 145: quantity times price is not the value. Branch-1.xlsx row 9: the same.", "the sentence that writes a row is rewritten the same way");
  assert.ok(!/Row \d{7,}/.test(labelled.detail), "no shifted row number ever reaches a person");
  assert.equal(labelReportRows(cited, ["one.xlsx"]), cited, "with one file nothing changes");

  const preview = {
    sampleCoded: [{ rawRowNumber: encodeFileRow(1, 7) }],
    ignoredRows: [{ rowNumber: encodeFileRow(1, 12) }, { rowNumber: 4 }],
  } as unknown as NormalizePreview;
  const labelledPreview = labelPreviewRows(preview, names);
  assert.equal(labelledPreview.sampleCoded[0].rawRowNumber, 7);
  assert.deepEqual(labelledPreview.ignoredRows.map((r) => [r.fileName, r.rowNumber]), [["branch-2.xlsx", 12], ["branch-1.xlsx", 4]], "every ignored row names its file");

  // 6. Several months: one report, passing only when every month passes, each finding naming its month.
  const passing = report([{ code: "recognition_coverage_summary", severity: "info", title: "Recognition coverage", detail: "d", count: 1, sampleRows: [] }]);
  const failing = report([{ code: "duplicate_sales_sheet", severity: "error", title: "Already imported", detail: "d", count: 1, sampleRows: [] }]);
  const combined = combineMonthReports([{ period: "2026-08", report: passing }, { period: "2026-09", report: failing }]);
  assert.equal(combined.ok, false, "one month that fails blocks the whole upload — nothing half-lands from the screen");
  assert.equal(combined.errorCount, 1);
  assert.deepEqual(combined.findings.map((f) => f.title), ["2026-08 · Recognition coverage", "2026-09 · Already imported"]);
  assert.equal(combineMonthReports([{ period: "2026-09", report: passing }]), passing, "one month reads exactly as before");

  // 7. The limit, and the wiring: the routes take every file and clean up every stored object.
  assert.equal(MAX_UPLOAD_FILES, 12);
  const service = stripComments(readFileSync("src/lib/sales/sales-upload.ts", "utf8"));
  assert.match(service, /count > MAX_UPLOAD_FILES/, "more than the limit is refused on the server");
  assert.match(service, /findRepeatedSheet\(/, "the same-sheet-twice check runs on the server");
  for (const route of ["app/api/sales/sales-upload/analyze/route.ts", "app/api/sales/sales-upload/commit/route.ts"]) {
    const text = stripComments(readFileSync(route, "utf8"));
    assert.match(text, /MonthlyUploadFiles\([^)]*\bfiles\b/, `${route} hands the service every chosen file`);
    assert.match(text, /for \(const one of files\)/, `${route} checks each file's type and size`);
    assert.match(text, /removeSalesUploadObjects\(cleanupStoragePaths\)/, `${route} deletes every temporary object`);
    assert.ok(text.indexOf("cleanupStoragePaths = resolved.storagePaths") < text.indexOf("if (!resolved.ok)"), `${route} collects the paths before a refusal returns, so a half-resolved upload is still cleaned up`);
  }
  const workspace = stripComments(readFileSync("src/components/sales/sales-upload-workspace.tsx", "utf8"));
  assert.match(workspace, /<input\s+accept="\.xlsx"\s+className="hidden"\s+multiple/, "the picker takes several sheets");
  assert.match(workspace, /for \(const f of files\) fd\.append\("file", f\)/, "the screen sends every chosen sheet");
  assert.match(workspace, /postSalesUpload\("\/api\/sales\/sales-upload\/analyze", files,/);
  assert.match(workspace, /postSalesUpload\("\/api\/sales\/sales-upload\/commit", files,/);
  assert.match(workspace, /f\.sampleRowLabels\?\.\[i\]/, "the validation panel shows which file each row is in");
}
