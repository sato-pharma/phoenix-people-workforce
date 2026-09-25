import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import ExcelJS from "exceljs";

import { buildBackupWorkbook, type DataBackupPayload } from "@/lib/admin/data-backup";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE ADMIN DATA BACKUP MUST BE WRITTEN ROW BY ROW, NOT ASSEMBLED IN MEMORY.
 *
 * `workbook.xlsx.writeBuffer()` renders each sheet into one `XmlStream`, whose `_xml` is a plain
 * JS array carrying ~15 string tokens per cell — measured 429 tokens for a 28-column row. V8 caps
 * an array at 2^27 = 134,217,728 entries, so that writer dies at ~312,861 rows of 28 columns with
 * a bare `RangeError: Invalid array length` out of `Array.push` inside `XmlStream.openNode`.
 *
 * `source_of_sales_import_rows` crossed that line before anyone noticed: 317,801 rows on staging
 * on 2026-09-11. The `sales` scope threw, and so did `all` — the DEFAULT — while `weekly` and
 * `marketing` kept producing files, which is what made it read as a data problem rather than a
 * ceiling. It is a ceiling, and no heap size reaches it: the cap is on the array, not the memory.
 *
 * So the guard here has two halves, and they fail for different reasons:
 *
 *   · the SOURCE half, below, is the one that catches a revert. Every artifact assertion in this
 *     file passes happily on the in-memory writer at test scale — a test big enough to throw would
 *     need ~8.8M cells and about a minute, which does not belong in this suite.
 *   · the ARTIFACT half guards the streaming rewrite's own hazard: a streamed sheet commits in
 *     order and cannot be revisited, so columns, tab colour and the frozen pane have to be set
 *     before the first row is written. Getting that wrong costs no error, only a plainer workbook.
 */
export async function runDataBackupWorkbookTests() {
  /** `row.values` is 1-based and comes back sparse; read the cells instead. */
  const cells = (sheet: ExcelJS.Worksheet, rowNumber: number, width: number) =>
    Array.from({ length: width }, (_, index) => sheet.getRow(rowNumber).getCell(index + 1).value);

  // ── The source half: the in-memory writer must not come back ─────────────────────────────────
  const modulePath = resolve(process.cwd(), "src/lib/admin/data-backup.ts");
  // Comments are stripped first: the module explains the ceiling by NAMING the call that hits it,
  // and a sweep that reads the explanation as the offence fails on the very file that fixed it.
  const code = stripComments(readFileSync(modulePath, "utf8"));

  assert.ok(
    code.includes("ExcelJS.stream.xlsx.WorkbookWriter"),
    "the backup workbook is built with the streaming writer — the in-memory one cannot render source_of_sales_import_rows",
  );
  assert.ok(
    !/\.xlsx\.writeBuffer\(/.test(code),
    "xlsx.writeBuffer() is the call that threw RangeError: Invalid array length on the sales and all scopes",
  );

  // ── The artifact half: build one and read it back ────────────────────────────────────────────
  const payload: DataBackupPayload = {
    generatedAt: "2026-09-11T09:00:00.000Z",
    generatedBy: "B-10",
    scope: "all",
    datasets: [
      {
        module: "sales",
        name: "SoS Upload Batches",
        rows: [
          { batch_id: "b-1", distributor_code: "IS", row_count: 120 },
          // A ragged row: the header set is the UNION of every row's keys, sorted.
          { batch_id: "b-2", distributor_code: "EGD", row_count: 7, note: "late file" },
        ],
      },
      { module: "sales", name: "SoS Distributor Profile", rows: [] },
      {
        module: "marketing",
        name: "Marketing Requests",
        rows: [{ id: "m-1", status: "approved" }],
      },
    ],
  };

  const buffer = await buildBackupWorkbook(payload);
  assert.ok((buffer as unknown as Buffer).length > 0, "the builder returns bytes");

  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(buffer);

  assert.deepEqual(
    reloaded.worksheets.map((sheet) => sheet.name),
    ["Contents", "SoS Upload Batches", "SoS Distributor Profile", "Marketing Requests"],
    "the Contents sheet is written first — a streamed workbook cannot insert one afterwards",
  );

  // Contents carries the scope, the stamp and a row count per table.
  const contents = reloaded.getWorksheet("Contents")!;
  assert.deepEqual(cells(contents, 1, 3), ["Module", "Table", "Row Count"]);
  assert.equal(contents.getRow(2).getCell(1).value, "Backup Scope");
  assert.equal(contents.getRow(2).getCell(2).value, "all");
  assert.equal(contents.getRow(4).getCell(2).value, "B-10");
  const countedTables = new Map<string, unknown>();
  contents.eachRow((row) => {
    const table = row.getCell(2).value;
    const count = row.getCell(3).value;
    if (typeof table === "string" && typeof count === "number") countedTables.set(table, count);
  });
  assert.equal(countedTables.get("SoS Upload Batches"), 2, "the summary counts the rows it wrote");
  assert.equal(countedTables.get("SoS Distributor Profile"), 0);

  // A data sheet: union header, sorted; every row present; blanks for the keys it lacks.
  const batches = reloaded.getWorksheet("SoS Upload Batches")!;
  assert.deepEqual(cells(batches, 1, 4), ["batch_id", "distributor_code", "note", "row_count"]);
  assert.deepEqual(cells(batches, 2, 4), ["b-1", "IS", null, 120], "a key this row lacks is blank, not shifted (an empty cell reloads as null)");
  assert.deepEqual(cells(batches, 3, 4), ["b-2", "EGD", "late file", 7]);
  assert.equal(batches.rowCount, 3, "one header row and one row per record");

  // The styling that has to be applied before the row is committed.
  assert.equal(batches.getRow(1).font?.bold, true, "the header row is bold");
  assert.equal(
    (batches.getRow(1).fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb,
    "FFF97316",
    "and carries its module's fill",
  );
  assert.equal(batches.properties.tabColor?.argb, "FFF97316", "the tab is coloured by module");
  assert.equal(batches.views[0]?.state, "frozen", "and the header row is frozen");
  assert.equal(batches.views[0]?.ySplit, 1);
  assert.equal(batches.autoFilter, "A1:D3", "the filter covers the header and every data row");

  // An empty table still gets a sheet, so a missing table is never mistaken for a missing sheet.
  const empty = reloaded.getWorksheet("SoS Distributor Profile")!;
  assert.equal(empty.getRow(1).getCell(1).value, "No rows");
  assert.equal(empty.rowCount, 1);
}
