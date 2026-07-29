import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { streamCrmMasterWorkbookResponse } from "../src/lib/crm/master-export-workbook.ts";
import type { CrmMasterColumn, CrmMasterRow } from "../src/lib/crm/master.ts";

// A representative slice of a Visits export, including the two columns with special export rendering
// (visit_time folds in its GPS/Logged source; recognition_score renders its label).
const COLUMNS: CrmMasterColumn[] = [
  { key: "crm_visit_id", kind: "number", label: "CRM Visit ID" },
  { key: "visit_date", kind: "date", label: "Visit Date" },
  { key: "visit_time", kind: "datetime_local", label: "Visit Time" },
  { key: "agent_name", kind: "text", label: "Agent Name" },
  { key: "recognition_score", kind: "number", label: "Recognized" },
];

function makeRow(id: number): CrmMasterRow {
  return {
    crm_visit_id: id,
    visit_date: "2026-07-15",
    visit_time: "2026-07-15T09:30:00",
    // Alternate the source so the "(GPS)" / "(Logged)" suffix is exercised on adjacent rows.
    visit_time_source: id % 2 === 0 ? "GPS check-in" : "Logged/save",
    agent_name: `Agent ${id}`,
    recognition_score: 100,
    recognition_missing: null,
  } as unknown as CrmMasterRow;
}

async function* pagesOf(total: number, pageSize: number): AsyncGenerator<CrmMasterRow[]> {
  for (let from = 0; from < total; from += pageSize) {
    const page: CrmMasterRow[] = [];
    for (let id = from + 1; id <= Math.min(total, from + pageSize); id += 1) page.push(makeRow(id));
    yield page;
  }
}

function isXlsx(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer);
  return bytes.length > 100 && bytes[0] === 0x50 && bytes[1] === 0x4b; // "PK" zip signature
}

export async function runCrmMasterExportWorkbookTests() {
  // ── 4,500 rows across 3 pages (2000 + 2000 + 500): the streaming writer must land EVERY row, so the
  //    export can cover the whole sheet — there is no 20k-style cap in the builder or the generator.
  const TOTAL = 4500;
  const response = streamCrmMasterWorkbookResponse({
    filename: "crm-visits-2026-07-15.xlsx",
    sheetName: "Visits",
    columns: COLUMNS,
    pages: pagesOf(TOTAL, 2000),
  });

  assert.equal(
    response.headers.get("Content-Type"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "must advertise the xlsx content type",
  );
  assert.match(
    response.headers.get("Content-Disposition") ?? "",
    /attachment; filename="crm-visits-2026-07-15\.xlsx"/,
    "must be an attachment download with the given filename",
  );

  const buffer = await response.arrayBuffer();
  assert.ok(isXlsx(buffer), "export must be a valid .xlsx (zip) buffer");

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer); // proves the streamed bytes form a well-formed workbook
  const sheet = workbook.getWorksheet("Visits");
  assert.ok(sheet, "workbook must contain the Visits sheet");

  // Header row (row 1) carries every column label.
  const headerValues = (sheet!.getRow(1).values as unknown[]).filter((v): v is string => typeof v === "string");
  for (const col of COLUMNS) assert.ok(headerValues.includes(col.label), `header must include "${col.label}"`);

  // Header (row 1) + every one of the 4,500 data rows — nothing dropped to a cap, none duplicated.
  assert.equal(sheet!.rowCount, TOTAL + 1, "all rows must be written (header + every data row), uncapped");
  // First and last data rows prove ordering is preserved end to end (values render as text strings).
  assert.equal(String(sheet!.getRow(2).getCell(1).value), "1", "first data row is visit 1");
  assert.equal(String(sheet!.getRow(TOTAL + 1).getCell(1).value), String(TOTAL), "last data row is the final visit");

  // Special-cell rendering matches renderExportCell (the same helper the on-screen table uses).
  const visitTimeCol = COLUMNS.findIndex((c) => c.key === "visit_time") + 1;
  const recognitionCol = COLUMNS.findIndex((c) => c.key === "recognition_score") + 1;
  assert.match(String(sheet!.getRow(2).getCell(visitTimeCol).value), /\(Logged\)$/, "odd row → Logged source suffix");
  assert.match(String(sheet!.getRow(3).getCell(visitTimeCol).value), /\(GPS\)$/, "even row → GPS source suffix");
  assert.equal(String(sheet!.getRow(2).getCell(recognitionCol).value), "100% Recognized", "recognition_score renders its label");

  // ── Error path: a page generator that throws mid-stream must ABORT the response body (reject),
  //    never hand the browser a truncated file that would be saved as if it were complete.
  async function* throwingPages(): AsyncGenerator<CrmMasterRow[]> {
    yield [makeRow(1)];
    throw new Error("simulated mid-stream query failure");
  }
  const failing = streamCrmMasterWorkbookResponse({
    filename: "crm-visits.xlsx",
    sheetName: "Visits",
    columns: COLUMNS,
    pages: throwingPages(),
  });
  await assert.rejects(
    async () => {
      await failing.arrayBuffer();
    },
    "a mid-stream error must reject the response body, not yield a partial workbook",
  );
}
