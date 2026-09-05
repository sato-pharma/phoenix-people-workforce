import ExcelJS from "exceljs";
import { once } from "node:events";
import { PassThrough, Readable } from "node:stream";

import { renderExportCell } from "@/lib/crm/master-cell-format";
import { HOUSE_XLSX_COLORS } from "@/lib/export/house-xlsx-identity";
import type { CrmMasterColumn, CrmMasterRow } from "@/lib/crm/master";

/**
 * THE MARK CANNOT APPEAR ON THIS EXPORT, and that is a property of streaming, not a choice.
 *
 * `ExcelJS.stream.xlsx.WorkbookWriter` has no `sheet.addImage` at all — calling it throws
 * "s.addImage is not a function". Worse, `workbook.addImage` DOES succeed and embeds the PNG:
 * measured, a streamed workbook came out carrying the 28KB image in `xl/media/` with ZERO drawing
 * parts referencing it. Every export would have grown by 28KB of bytes nothing can display. So this
 * file deliberately never calls addImage, and the identity is carried by type and rule alone.
 */

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
  /** Provenance for the cover: scope, date window, search, whatever the caller filtered by. */
  cover?: { rows: Array<[string, string]>; subtitle: string; title: string };
}): Response {
  const pass = new PassThrough();
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: pass,
    useStyles: true,
    useSharedStrings: false,
  });
  workbook.creator = "Phoenix Workforce";

  // The cover goes FIRST, because a streamed workbook commits its sheets in order and there is no
  // going back to insert one. It deliberately carries no row COUNT: the rows have not been
  // generated yet when this is written, and that is the whole point of streaming — a count here
  // would have to be a second query, or a guess.
  //
  // The data sheet is still found by NAME (`getWorksheet("Visits")`), so putting a sheet before it
  // moves nothing that reads this file.
  if (opts.cover) {
    const cover = workbook.addWorksheet("Cover", { views: [{ showGridLines: false }] });
    cover.getColumn(1).width = 4;
    cover.getColumn(2).width = 32;
    cover.getColumn(3).width = 92;

    const write = (
      rowNumber: number,
      label: string,
      value: string,
      style: "title" | "subtitle" | "rule" | "heading" | "row",
    ) => {
      const row = cover.getRow(rowNumber);
      if (style === "rule") {
        for (let column = 1; column <= 3; column += 1) {
          row.getCell(column).fill = {
            fgColor: { argb: HOUSE_XLSX_COLORS.blue },
            pattern: "solid",
            type: "pattern",
          };
        }
        row.height = 3;
        row.commit();
        return;
      }
      const labelCell = row.getCell(2);
      const valueCell = row.getCell(3);
      labelCell.value = label;
      valueCell.value = value;
      if (style === "title") {
        labelCell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos Display", size: 16 };
        row.height = 26;
      } else if (style === "subtitle") {
        labelCell.font = { color: { argb: HOUSE_XLSX_COLORS.muted }, name: "Aptos", size: 9 };
        row.height = 16;
      } else if (style === "heading") {
        labelCell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos", size: 11 };
        labelCell.border = { bottom: { color: { argb: HOUSE_XLSX_COLORS.hair }, style: "thin" } };
        valueCell.border = { bottom: { color: { argb: HOUSE_XLSX_COLORS.hair }, style: "thin" } };
      } else {
        for (const cell of [labelCell, valueCell]) {
          cell.font = { color: { argb: HOUSE_XLSX_COLORS.body }, name: "Aptos", size: 9.5 };
          cell.alignment = { horizontal: "left", vertical: "top", wrapText: true };
        }
        labelCell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.body }, name: "Aptos", size: 9.5 };
      }
      row.commit();
    };

    write(1, opts.cover.title, "", "title");
    write(2, opts.cover.subtitle, "", "subtitle");
    write(3, "", "", "rule");
    write(5, "Report provenance", "", "heading");
    opts.cover.rows.forEach(([label, value], index) => write(6 + index, label, value, "row"));
    cover.commit();
  }

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
        cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos", size: 9.5 };
        cell.alignment = { horizontal: "left", vertical: "bottom", wrapText: true };
        cell.border = {
          bottom: { color: { argb: HOUSE_XLSX_COLORS.blue }, style: "medium" },
          top: { color: { argb: HOUSE_XLSX_COLORS.hair }, style: "thin" },
        };
      });
      header.height = 26;
      header.commit();

      // THE HEADER STAYS ON ROW 1 — no masthead above it, unlike every other export in this pass.
      // This one is a data DUMP: one row per visit, opened to be pivoted, filtered and fed to Power
      // Query, all of which expect the header first. Banner rows would break Ctrl+A, "Format as
      // Table" and pivot creation for the sake of decoration. The identity lives on the Cover sheet
      // instead, which costs the data sheet nothing.
      let bodyRowNumber = 1;
      for await (const page of opts.pages) {
        for (const row of page) {
          const record = row as unknown as Record<string, unknown>;
          const excelRow = sheet.addRow(opts.columns.map((col) => renderExportCell(record, col)));
          bodyRowNumber += 1;
          const zebra = bodyRowNumber % 2 === 0;
          excelRow.eachCell((cell) => {
            cell.font = { color: { argb: HOUSE_XLSX_COLORS.body }, name: "Aptos", size: 9.5 };
            cell.alignment = { vertical: "middle" };
            if (zebra) {
              cell.fill = { fgColor: { argb: HOUSE_XLSX_COLORS.tint }, pattern: "solid", type: "pattern" };
            }
          });
          excelRow.commit();
        }
        // Backpressure. `Row.commit()` writes into `pass` synchronously and returns nothing
        // awaitable, and `Readable.toWeb(pass)` only propagates backpressure to the READER — so
        // nothing throttled the producer. If the client or the Cloud Run proxy consumed slower
        // than rows were generated (a ~110k-row export over a slow link), `pass` buffered without
        // bound and the docstring's "server memory stays flat" quietly stopped being true. Waiting
        // for `drain` between pages bounds it to roughly one page of rows.
        if (pass.writableLength > pass.writableHighWaterMark) {
          await once(pass, "drain");
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
