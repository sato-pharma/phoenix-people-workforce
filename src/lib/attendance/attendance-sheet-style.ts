/**
 * The house identity, applied to the attendance reports.
 *
 * WHY THIS IS ITS OWN MODULE. The fingerprint report and the monthly summary each carried a private
 * copy of the same four styling functions — an orange title fill, a navy header band, a soft grid,
 * and a body style — differing only in whitespace. Two copies of one identity is one identity that
 * happens to agree today, and neither was the identity the company actually uses. The device-user
 * mapping template had a third variation again.
 *
 * SEVERITY IS CARRIED BY TYPE, NOT BY A FILL. Both reports tinted a cell green / orange / pink to
 * grade it — a complete day against a short one, nought absences against three. The house palette is
 * three blues and black, so there is no honest way to render a three-step scale in fills without
 * inventing colours the company mark does not contain. Weight and colour of TYPE say the same thing,
 * survive greyscale, and leave the 6% zebra as the only fill on the sheet — which is what makes an
 * exceptional row stand out at all.
 *
 * `attendanceSeverityFont` is deliberately the ONLY way these sheets grade a cell, so the fingerprint
 * report's "Short day" and the summary's "2 absences" cannot drift into meaning different things to
 * a reader who opens both.
 */

import type ExcelJS from "exceljs";

import { HOUSE_XLSX_COLORS, writeHouseMasthead } from "@/lib/export/house-xlsx-identity";

/** Masthead rows 1-3; each report then writes its own notes before the header. */
export const ATTENDANCE_MASTHEAD_ROWS = 3;

export type AttendanceSeverity = "normal" | "watch" | "alert";

/**
 * How a graded cell reads.
 *
 * "watch" is Brand Blue rather than an amber, because there is no amber in the mark — a middle step
 * that is merely NOTICED reads correctly in the deep blue, and reserving the flag colour for the
 * top step keeps it meaning something.
 */
export function attendanceSeverityFont(severity: AttendanceSeverity): Partial<ExcelJS.Font> {
  if (severity === "alert") {
    return { bold: true, color: { argb: HOUSE_XLSX_COLORS.flag }, name: "Aptos", size: 9.5 };
  }
  if (severity === "watch") {
    return { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos", size: 9.5 };
  }
  return { color: { argb: HOUSE_XLSX_COLORS.body }, name: "Aptos", size: 9.5 };
}

export function writeAttendanceMasthead(
  workbook: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
  input: { columns: number; provenance?: string[]; subtitle: string; title: string },
) {
  sheet.views = [{ showGridLines: false }];
  writeHouseMasthead(workbook, sheet, {
    columns: input.columns,
    provenance: input.provenance ?? [],
    subtitle: input.subtitle,
    title: input.title,
  });
}

/**
 * A note line under the masthead.
 *
 * `alert` renders it in the flag colour and bold. The monthly summary uses that for the one thing
 * on the sheet that must never be missed: days the attendance device never reported are excluded
 * from Expected and Absent upstream, so without the note a month with missing data reads as a
 * well-behaved one.
 */
export function writeAttendanceNote(
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
  columns: number,
  text: string,
  options: { alert?: boolean } = {},
) {
  sheet.mergeCells(rowNumber, 1, rowNumber, Math.max(1, columns));
  const cell = sheet.getCell(rowNumber, 1);
  cell.value = text;
  cell.font = options.alert
    ? { bold: true, color: { argb: HOUSE_XLSX_COLORS.flag }, name: "Aptos", size: 9.5 }
    : { color: { argb: HOUSE_XLSX_COLORS.muted }, name: "Aptos", size: 9 };
  cell.alignment = { horizontal: "left", indent: 1, vertical: "middle", wrapText: true };
  if (options.alert) {
    cell.border = { left: { style: "thick", color: { argb: HOUSE_XLSX_COLORS.flag } } };
  }
  sheet.getRow(rowNumber).height = options.alert ? 26 : 16;
}

/** Column headers: deep type on white under a Brand Blue rule. Never a filled band. */
export function styleAttendanceHeaderRow(row: ExcelJS.Row) {
  row.height = 26;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos", size: 9.5 };
    cell.alignment = { horizontal: "left", vertical: "bottom", wrapText: true };
    cell.border = {
      bottom: { style: "medium", color: { argb: HOUSE_XLSX_COLORS.blue } },
      top: { style: "thin", color: { argb: HOUSE_XLSX_COLORS.hair } },
    };
  });
}

/** Body row; the 6% zebra is the only fill in the format. */
export function styleAttendanceBodyRow(row: ExcelJS.Row, options: { zebra: boolean }) {
  row.eachCell((cell) => {
    cell.font = { color: { argb: HOUSE_XLSX_COLORS.body }, name: "Aptos", size: 9.5 };
    cell.alignment = { vertical: "middle" };
    if (options.zebra) {
      cell.fill = { fgColor: { argb: HOUSE_XLSX_COLORS.tint }, pattern: "solid", type: "pattern" };
    } else {
      cell.border = { bottom: { style: "hair", color: { argb: HOUSE_XLSX_COLORS.hair } } };
    }
  });
}
