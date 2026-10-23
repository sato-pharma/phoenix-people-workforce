/**
 * System Error & Data Integrity Audit — the CSV and XLSX export.
 *
 * EVERY FILTERED ROW, NEVER A PAGE. The route feeds this the keyset batches from
 * `iterateSystemAuditExport` (5,000 rows a call, ordered by occurred_at then id, so ties on the
 * same instant are neither skipped nor repeated) and both formats are written batch by batch as they
 * arrive — the file never stops at the screen's 50 rows or at PostgREST's 1,000-row cap.
 * tests/system-audit-export.test.ts proves it with 12,345 rows across three batches with ties.
 *
 * NO CELL IS EVER A FORMULA. Every text cell passes through `spreadsheetSafe`/`spreadsheetSafeText`
 * (src/lib/export/spreadsheet-safe.ts): a message a browser sent us that begins `=`, `+`, `-`, `@`,
 * a tab, a carriage return, a space or the full-width `＝` reaches the file as text.
 *
 * Column order: the screen's 11 columns, then the technical columns an engineer needs.
 */

import ExcelJS from "exceljs";
import { once } from "node:events";
import type { Writable } from "node:stream";

import { CSV_BOM, csvLine, spreadsheetSafe, spreadsheetSafeText } from "@/lib/export/spreadsheet-safe";
import { HOUSE_XLSX_COLORS, HOUSE_XLSX_FONT } from "@/lib/export/house-xlsx-palette";
import { cairoDateTimeSortable } from "@/lib/format/cairo-datetime";
import {
  INCIDENT_COLUMN_HEADINGS,
  familyLabel,
  incidentCairoDateSortable,
  incidentCairoTime,
  incidentCodeAndRef,
  incidentEmployeeName,
  incidentHrId,
  incidentMessage,
  incidentScope,
  incidentStatus,
  incidentWhy,
  moduleLabelSourceLabel,
} from "@/lib/system-audit/incidents-display";
import type { SystemAuditExportBatch, SystemAuditPageRow } from "@/lib/system-audit/types";

export const SYSTEM_AUDIT_TECHNICAL_HEADINGS = [
  "Signature",
  "Source",
  "Address (route)",
  "System message",
  "Attempts",
  "Page loads",
  "First event (Cairo)",
  "Last event (Cairo)",
  "Module label source",
  "Occurrence ID",
] as const;

export const SYSTEM_AUDIT_EXPORT_HEADINGS: readonly string[] = [
  ...INCIDENT_COLUMN_HEADINGS,
  ...SYSTEM_AUDIT_TECHNICAL_HEADINGS,
];

/**
 * Above this the XLSX path refuses and points at CSV: a spreadsheet past 100,000 rows is slow to
 * open and the CSV streams any size. The CSV has no cap at all.
 */
export const SYSTEM_AUDIT_XLSX_ROW_LIMIT = 100_000;

export class SystemAuditExportTooLargeError extends Error {
  readonly status = 413;
  readonly rows: number;
  constructor(rows: number) {
    super(
      `At least ${rows.toLocaleString("en-US")} rows match these filters — more than the ${SYSTEM_AUDIT_XLSX_ROW_LIMIT.toLocaleString("en-US")} an XLSX export carries. Download the CSV instead (it has no limit), or narrow the filters.`,
    );
    this.name = "SystemAuditExportTooLargeError";
    this.rows = rows;
  }
}

type ExportValue = string | number;

/**
 * One row's values, in heading order, BEFORE neutralising. Counts that are real numbers stay
 * numbers (a spreadsheet can sum them); a system row's column 10 is "—", never 0.
 */
export function systemAuditExportValues(row: SystemAuditPageRow): ExportValue[] {
  return [
    incidentHrId(row),
    incidentEmployeeName(row),
    row.moduleLabel,
    incidentCairoDateSortable(row),
    incidentCairoTime(row),
    incidentMessage(row),
    incidentCodeAndRef(row),
    incidentWhy(row),
    incidentStatus(row),
    row.hrKey ? row.personOps : "—",
    incidentScope(row),
    row.signatureKey,
    familyLabel(row.family),
    row.route ?? "",
    row.technicalMessage ?? "",
    row.attemptCount,
    row.pageLoads,
    cairoDateTimeSortable(row.firstEventAt),
    cairoDateTimeSortable(row.lastEventAt),
    moduleLabelSourceLabel(row.moduleLabelSource),
    row.id,
  ];
}

/** One CSV line (no line break). `csvLine` neutralises and quotes every field. */
export function systemAuditCsvLine(row: SystemAuditPageRow): string {
  return csvLine(systemAuditExportValues(row));
}

/** The header line, BOM first so Excel reads Arabic names as UTF-8. */
export function systemAuditCsvHeader(): string {
  return `${CSV_BOM}${csvLine(SYSTEM_AUDIT_EXPORT_HEADINGS)}\r\n`;
}

/**
 * One row's XLSX cells. Text through `spreadsheetSafeText`, real numbers through
 * `spreadsheetSafe` (which keeps a finite number a number) — nothing reaches a cell raw.
 */
export function systemAuditXlsxCells(row: SystemAuditPageRow): Array<string | number> {
  return systemAuditExportValues(row).map((value) => {
    if (typeof value === "number") {
      const safe = spreadsheetSafe(value);
      return typeof safe === "number" ? safe : spreadsheetSafeText(value);
    }
    return spreadsheetSafeText(value);
  });
}

export type ExportFinish = { rows: number; error: unknown | null };

/**
 * The CSV as a pull stream: the header, then one chunk per keyset batch, read only when the
 * client asks for more — so a slow download never makes the server hold the whole file.
 * `onFinish` runs exactly once, with the row count, on success, failure or a cancelled download.
 */
export function createSystemAuditCsvStream(
  batches: AsyncIterable<SystemAuditExportBatch>,
  onFinish?: (result: ExportFinish) => void | Promise<void>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = batches[Symbol.asyncIterator]();
  let rows = 0;
  let headerSent = false;
  let finished = false;
  const finish = async (error: unknown | null) => {
    if (finished) return;
    finished = true;
    await onFinish?.({ rows, error });
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!headerSent) {
          headerSent = true;
          controller.enqueue(encoder.encode(systemAuditCsvHeader()));
          return;
        }
        // Skip empty batches rather than enqueueing nothing: a pull that enqueues nothing is
        // never pulled again.
        for (;;) {
          const next = await iterator.next();
          if (next.done) {
            controller.close();
            await finish(null);
            return;
          }
          const batch = next.value.rows;
          if (batch.length === 0) continue;
          let text = "";
          for (const row of batch) text += `${systemAuditCsvLine(row)}\r\n`;
          rows += batch.length;
          controller.enqueue(encoder.encode(text));
          return;
        }
      } catch (error) {
        await finish(error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await iterator.return?.(undefined);
      await finish(reason ?? new Error("The download was cancelled."));
    },
  });
}

const XLSX_COLUMN_WIDTHS = [12, 26, 28, 13, 10, 44, 24, 48, 26, 14, 30, 36, 24, 32, 52, 10, 10, 18, 18, 24, 38];

export type SystemAuditWorkbookMeta = {
  /** The Super Admin who asked for it — a name, never only an id. */
  generatedBy: string;
  /** describeSystemAuditFilters(...) */
  filters: string;
  generatedAtIso?: string;
  /** Updated as rows are written, so a caller can say how far a failed export got. */
  progress?: { rows: number };
};

/**
 * Write the XLSX into `stream`, batch by batch (ExcelJS streaming writer — server memory stays
 * flat). An export batch carries NO total, so this counts what it writes. The route checks the
 * screen total (one `loadSystemAuditPage` with limit 1) BEFORE the download starts and refuses
 * above the XLSX limit with a sentence pointing at the CSV; the count here is the safety net for
 * rows that arrive between that check and the walk — past the limit it stops with the same error
 * instead of writing an XLSX nobody can open.
 *
 * Sheet 1 "Incidents": the header on row 1, frozen, then every row. Sheet 2 "About this export":
 * who, when, the filters and the row count — written last, because the count is only known then.
 */
export async function writeSystemAuditWorkbook(
  batches: AsyncIterable<SystemAuditExportBatch>,
  stream: Writable,
  meta: SystemAuditWorkbookMeta,
): Promise<{ rows: number }> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: true, useSharedStrings: false });
  workbook.creator = "Phoenix Workforce";

  const sheet = workbook.addWorksheet("Incidents", { views: [{ state: "frozen", ySplit: 1 }] });
  SYSTEM_AUDIT_EXPORT_HEADINGS.forEach((_, index) => {
    sheet.getColumn(index + 1).width = XLSX_COLUMN_WIDTHS[index] ?? 18;
  });

  const header = sheet.getRow(1);
  SYSTEM_AUDIT_EXPORT_HEADINGS.forEach((heading, index) => {
    const cell = header.getCell(index + 1);
    cell.value = spreadsheetSafeText(heading);
    cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.white }, name: HOUSE_XLSX_FONT, size: 9.5 };
    cell.fill = { fgColor: { argb: HOUSE_XLSX_COLORS.deep }, pattern: "solid", type: "pattern" };
    cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
  });
  header.height = 30;
  header.commit();

  const bodyFont = { color: { argb: HOUSE_XLSX_COLORS.body }, name: HOUSE_XLSX_FONT, size: 9.5 };
  const bodyAlignment = { vertical: "top" as const, wrapText: true };
  const zebraFill = { fgColor: { argb: HOUSE_XLSX_COLORS.tint }, pattern: "solid" as const, type: "pattern" as const };

  let rows = 0;
  const writeBatch = async (batch: SystemAuditPageRow[]) => {
    if (rows + batch.length > SYSTEM_AUDIT_XLSX_ROW_LIMIT) {
      throw new SystemAuditExportTooLargeError(rows + batch.length);
    }
    for (const row of batch) {
      const excelRow = sheet.addRow(systemAuditXlsxCells(row));
      rows += 1;
      const zebra = rows % 2 === 0;
      excelRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.font = bodyFont;
        cell.alignment = bodyAlignment;
        if (zebra) cell.fill = zebraFill;
      });
      excelRow.commit();
    }
    if (meta.progress) meta.progress.rows = rows;
    // Backpressure: Row.commit() writes synchronously into the stream, so wait for it to drain
    // between batches rather than buffering the whole file in memory.
    const writable = stream as Writable & { writableLength?: number; writableHighWaterMark?: number };
    if ((writable.writableLength ?? 0) > (writable.writableHighWaterMark ?? Number.POSITIVE_INFINITY)) {
      await once(stream, "drain");
    }
  };

  for await (const batch of batches) {
    await writeBatch(batch.rows);
  }
  sheet.commit();

  const about = workbook.addWorksheet("About this export");
  about.getColumn(1).width = 26;
  about.getColumn(2).width = 100;
  const aboutRows: Array<[string, string]> = [
    ["Report", "System Error & Data Integrity Audit"],
    ["Generated (Cairo)", cairoDateTimeSortable(meta.generatedAtIso ?? new Date().toISOString())],
    ["Generated by", meta.generatedBy],
    ["Filters", meta.filters],
    ["Rows", rows.toLocaleString("en-US")],
    [
      "Column 6",
      "The words the person saw. Where they were not recorded the cell says so; the technical text is the System message column.",
    ],
  ];
  aboutRows.forEach(([label, value]) => {
    const row = about.addRow([spreadsheetSafeText(label), spreadsheetSafeText(value)]);
    row.getCell(1).font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: HOUSE_XLSX_FONT, size: 10 };
    row.getCell(2).font = { color: { argb: HOUSE_XLSX_COLORS.body }, name: HOUSE_XLSX_FONT, size: 10 };
    row.getCell(2).alignment = { vertical: "top", wrapText: true };
    row.commit();
  });
  about.commit();

  await workbook.commit();
  return { rows };
}

/** `system-audit-2026-10-23.csv`, dated in Cairo. */
export function systemAuditExportFilename(format: "csv" | "xlsx", nowIso: string = new Date().toISOString()): string {
  const day = cairoDateTimeSortable(nowIso).slice(0, 10);
  return `system-audit-${day}.${format}`;
}

/**
 * The first keyset batch is read BEFORE the response starts, so a database that cannot answer
 * returns a plain error instead of a half-written file. This puts that batch back in front of the
 * rest.
 */
export async function* resumeBatches(
  first: IteratorResult<SystemAuditExportBatch, void>,
  rest: AsyncIterator<SystemAuditExportBatch, void, void>,
): AsyncGenerator<SystemAuditExportBatch, void, void> {
  if (first.done) return;
  yield first.value;
  for (;;) {
    const next = await rest.next();
    if (next.done) return;
    yield next.value;
  }
}
