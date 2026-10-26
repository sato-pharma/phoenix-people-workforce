import ExcelJS from "exceljs";

import type { AssembledRow } from "../assemble.ts";
import type { NonEmployeePayrollRow } from "../types.ts";
import { heldForScope, resolveBankRoute } from "./bank-coverage.ts";

/**
 * CIB (Commercial International Bank) bulk-credit template. Schema AND
 * styling (fonts, colors, fills, borders, alignment) reverse-engineered cell-
 * by-cell from the company's own real "details_Sheet.xls" via xlrd's XF/font
 * records (2026-07-26 audit) — a fixed-width, mainframe-style layout with a
 * genuinely distinctive design: a bold dark-red-on-yellow header, and a
 * yellow-highlighted Employee_Account_No column with hairline borders (likely
 * to draw the eye to double-check the account number). Different philosophy
 * from FAB's plain labeled columns (see fab-sheet.ts). Only 8 raw columns are
 * the actual bank format; Full_Name and the second "Amount" column past
 * Filler are a human-readability annex (name + the same amount as a real,
 * readable number instead of the fixed-width code) — the reference file
 * genuinely repeats the "Amount" header for this column, not a typo.
 *
 * One deliberate deviation from the literal reference: Employee_Account_No
 * is written as TEXT here, not the NUMBER type the reference file used.
 * Every real CIB account sampled starts with a non-zero digit ("100..."),
 * so this changes nothing for current data — it only guards against a
 * future account number that starts with "0" silently losing its leading
 * zero, the same protection FAB's sheet already has. Flag this to the owner
 * before treating this module as a literal, zero-deviation replica the way
 * fab-sheet.ts is.
 */

export const CIB_DETAILS_ID = "D";
export const CIB_BRANCH_CODE = "042";
export const CIB_CURRENCY = "EGP";
export const CIB_DEBIT_CREDIT = "C";
export const CIB_REASON_CODE = "R";

export type CibSheetRow = {
  fullName: string;
  bankAccount: string;
  salary: number;
};

/** amount*100, zero-padded to 13 digits — the fixed-point PIC 9(11)V99 mainframe convention seen in the reference file. */
export function formatCibAmount(amount: number): string {
  return Math.round(amount * 100).toString().padStart(13, "0");
}

/**
 * CIB-bank employees only, for one part of a run's payout. Same rules as
 * fabRowsForScope: held employees excluded, zero-amount rows excluded.
 */
export function cibRowsForScope(rows: AssembledRow[], scope: "part1" | "part2"): CibSheetRow[] {
  return rows
    .filter((entry) => !heldForScope(entry, scope))
    // One routing definition, shared with fab-sheet.ts and bank-coverage.ts. Same decision as the
    // literal string test it replaces; the difference is that an unrouted row is now named rather
    // than silently dropped.
    .filter((entry) => resolveBankRoute({ bankName: entry.bankName, bankAccount: entry.bankAccount }).route === "CIB")
    .map((entry) => ({
      fullName: entry.row.fullName,
      bankAccount: (entry.bankAccount ?? "").trim(),
      salary: scope === "part1" ? entry.row.firstPart : entry.row.secondPart,
    }))
    .filter((entry) => entry.salary > 0 && entry.bankAccount.length > 0);
}

/**
 * CIB-bank Non-Employees Payroll rows (people paid a monthly salary with no
 * employee/HR_ID record — owner rule 2026-07-25/26 misses this without it, since
 * they are a completely separate data source from AssembledRow and don't run
 * through cibRowsForScope at all).
 *
 * Each entry's own `part` decides which file carries it (owner request
 * 2026-08-03) — see fabRowsForNonEmployees for the same rule and the same
 * previously-unpayable case it fixes.
 */
export function cibRowsForNonEmployees(
  nonEmployees: NonEmployeePayrollRow[],
  scope: "part1" | "part2",
): CibSheetRow[] {
  const part = scope === "part1" ? "first" : "second";
  return nonEmployees
    .filter((entry) => entry.part === part)
    .filter((entry) => resolveBankRoute({ bankName: entry.bankName, bankAccount: entry.bankAccount }).route === "CIB")
    .map((entry) => ({
      fullName: entry.fullNameEn,
      bankAccount: (entry.bankAccount ?? "").trim(),
      salary: entry.totalSalary,
    }))
    .filter((entry) => entry.salary > 0 && entry.bankAccount.length > 0);
}

/**
 * The CIB bulk-credit workbook: one unbranded sheet, the 8 raw bank-format
 * columns plus a Full_Name annex column for human review. No protection —
 * finance may need to hand-adjust a value before submitting.
 */
export async function buildCibSheetWorkbook(input: { rows: CibSheetRow[] }): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");

  sheet.columns = [
    { header: "Details_ID", key: "detailsId", width: 10 },
    { header: "Branch_Code", key: "branchCode", width: 11 },
    { header: "Employee_Account_No", key: "employeeAccount", width: 20 },
    { header: "Currency_Code", key: "currency", width: 12 },
    { header: "Amount", key: "amount", width: 15 },
    { header: "Debit_Credit", key: "debitCredit", width: 12 },
    { header: "Reason_code", key: "reasonCode", width: 11 },
    { header: "Filler", key: "filler", width: 8 },
    { header: "Full_Name", key: "fullName", width: 40 },
    { header: "Amount", key: "readableAmount", width: 15 },
  ];

  // Header: bold MS Sans Serif 10, dark-red/maroon text (ARGB FF800000) on a
  // solid yellow fill (ARGB FFFFFF00), thick top border + thin bottom border —
  // verified cell-by-cell against details_Sheet.xls's real XF/font records on
  // 2026-07-26. Branch_Code/Employee_Account_No are left-aligned in the
  // reference; every other column is centered.
  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = { name: "MS Sans Serif", size: 10, bold: true, color: { argb: "FF800000" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
    cell.border = { top: { style: "thick" }, bottom: { style: "thin" } };
  });
  headerRow.getCell("branchCode").alignment = { horizontal: "left" };
  headerRow.getCell("employeeAccount").alignment = { horizontal: "left" };
  ["detailsId", "currency", "amount", "debitCredit", "reasonCode", "filler", "fullName", "readableAmount"].forEach(
    (key) => {
      headerRow.getCell(key).alignment = { horizontal: "center" };
    },
  );

  for (const row of input.rows) {
    const excelRow = sheet.addRow({
      detailsId: CIB_DETAILS_ID,
      branchCode: CIB_BRANCH_CODE,
      employeeAccount: row.bankAccount,
      currency: CIB_CURRENCY,
      amount: formatCibAmount(row.salary),
      debitCredit: CIB_DEBIT_CREDIT,
      reasonCode: CIB_REASON_CODE,
      filler: "",
      fullName: row.fullName.toUpperCase(),
      readableAmount: row.salary,
    });
    // Every raw column except Branch_Code is bold in the reference (Branch_Code
    // is the one column that isn't) — same per-column pattern on every real row.
    excelRow.eachCell((cell) => {
      cell.font = { name: "MS Sans Serif", size: 10, bold: true };
    });
    excelRow.getCell("branchCode").font = { name: "Arial", size: 12, bold: false };
    // Employee_Account_No: the reference highlights this column yellow with
    // hairline top/bottom borders — likely to draw the eye to double-check it.
    excelRow.getCell("employeeAccount").font = { name: "Calibri", size: 14, bold: false };
    excelRow.getCell("employeeAccount").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
    excelRow.getCell("employeeAccount").border = { top: { style: "hair" }, bottom: { style: "hair" } };
    excelRow.getCell("employeeAccount").alignment = { horizontal: "center" };
    // Amount: the reference uses "Traditional Arabic", right-aligned.
    excelRow.getCell("amount").font = { name: "Traditional Arabic", size: 12, bold: true };
    excelRow.getCell("amount").alignment = { horizontal: "right" };
    excelRow.getCell("fullName").font = { name: "Arial", size: 10, bold: true };
    // Readable Amount annex (the reference's second "Amount" column): a real
    // number, not the fixed-width code, so a human can sanity-check it at a glance.
    excelRow.getCell("readableAmount").font = { name: "Arial", size: 10, bold: true };
    excelRow.getCell("readableAmount").alignment = { horizontal: "right" };
    excelRow.getCell("readableAmount").numFmt = "#,##0.00";

    excelRow.getCell("branchCode").numFmt = "@";
    excelRow.getCell("employeeAccount").numFmt = "@";
    excelRow.getCell("amount").numFmt = "@";
  }

  return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
}
