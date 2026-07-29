import ExcelJS from "exceljs";
import { PassThrough, Readable } from "node:stream";

import { renderExportCell } from "@/lib/crm/master-cell-format";
import type { CrmMasterColumn, CrmMasterRow } from "@/lib/crm/master";

const BLACK = "FF000000";
const WHITE = "FFFFFFFF";

/** Excel forbids \ / ? * [ ] : in a sheet name and caps it at 31 chars. */
function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, " ").trim();
  return (cleaned || "Export").slice(0, 31);
}

/**
 * Build a streaming XLSX download Response from a page-generator of CRM master rows.
 *
 * The workbook is written row-by-row into a Node stream that is piped straight to the HTTP response,
 * so server memory stays flat no matter how many rows the export contains — this is what lets the
 * export cover the whole sheet without the OOM/timeout the old single-pass in-memory builder hit on
 * the 1Gi instance. Cells are rendered with the SAME renderExportCell the on-screen table uses, so
 * the file matches the UI column-for-column.
 */
export function streamCrmMasterWorkbookResponse(opts: {
  filename: string;
  sheetName: string;
  columns: readonly CrmMasterColumn[];
  pages: AsyncIterable<CrmMasterRow[]>;
}): Response {
  const pass = new PassThrough();
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: pass,
    useStyles: true,
    useSharedStrings: false,
  });
  workbook.creator = "Phoenix Workforce";
  const sheet = workbook.addWorksheet(sanitizeSheetName(opts.sheetName), {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  // Column widths must be set before any row is committed (they are written into the sheet header).
  // No data sample is available while streaming, so size from the label — good enough for a grid.
  opts.columns.forEach((col, index) => {
    sheet.getColumn(index + 1).width = Math.max(12, Math.min(48, col.label.length + 6));
  });

  // Write + finalize in the background; the Response streams from `pass` as bytes are produced. This
  // is intentionally not awaited — returning the stream immediately lets Next flush it to the client
  // incrementally instead of buffering the whole file first.
  void (async () => {
    try {
      const header = sheet.getRow(1);
      opts.columns.forEach((col, index) => {
        const cell = header.getCell(index + 1);
        cell.value = col.label;
        cell.font = { name: "Calibri", size: 11.5, bold: true, color: { argb: WHITE } };
        cell.alignment = { vertical: "middle", horizontal: "center" };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } };
      });
      header.height = 22;
      header.commit();

      for await (const page of opts.pages) {
        for (const row of page) {
          const record = row as unknown as Record<string, unknown>;
          sheet.addRow(opts.columns.map((col) => renderExportCell(record, col))).commit();
        }
      }

      sheet.commit();
      await workbook.commit();
    } catch (error) {
      // Abort the stream so the client's fetch rejects (and shows the error) instead of silently
      // saving a truncated, corrupt workbook.
      pass.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  })();

  return new Response(Readable.toWeb(pass) as unknown as ReadableStream<Uint8Array>, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${opts.filename}"`,
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  });
}
