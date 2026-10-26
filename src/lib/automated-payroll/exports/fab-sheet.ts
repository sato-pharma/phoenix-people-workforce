import ExcelJS from "exceljs";

import type { AssembledRow } from "../assemble.ts";
import type { NonEmployeePayrollRow, PayrollPeriod } from "../types.ts";
import { heldForScope, resolveBankRoute } from "./bank-coverage.ts";

/**
 * FAB (First Abu Dhabi Bank / FABMISR) bulk salary-transfer upload file.
 * Schema — column order, exact header strings, and every constant below —
 * was verified cell-by-cell against the company's own real May 2026 bank
 * submission (FAB.xlsx, 101 rows) on 2026-07-26. This generates a literal
 * bank-execution artifact: do not "improve", reformat, reorder, or rename
 * anything here without re-verifying against a file FAB has actually
 * accepted. Per owner instruction, Title is ALWAYS "Mr." regardless of the
 * employee's actual gender, matching the reference file exactly (all 101
 * rows there use "Mr.", including clearly female employees) — this is a
 * deliberate literal replication, not an oversight.
 */

/** Sato Pharma's own FAB disbursement account — constant on every row of the reference file. */
export const FAB_COMPANY_ACCOUNT_NUMBER = "00716838";
/** FAB's own bank-code label for its bulk file — distinct from employees.bank_name ("FAB"). */
export const FAB_BANK_LABEL = "FABMISR";
export const FAB_CURRENCY = "EGP";
export const FAB_TRNS_DESC = "Salary";
export const FAB_TITLE = "Mr.";

export type FabSheetRow = {
  fullName: string;
  bankAccount: string;
  salary: number;
};

/** The 25th of the run's month — the reference file's own value-date convention. Caller may override. */
export function defaultFabValueDate(period: PayrollPeriod): Date {
  return new Date(Date.UTC(period.year, period.month - 1, 25));
}

/**
 * FAB-bank employees only, for one part of a run's payout. Held employees are
 * always excluded (same rule as publish). Zero-amount rows are excluded too
 * (owner rule 2026-07-26) — e.g. a leaver fully settled in Part 1 has a
 * Part-2 amount of 0 and has no reason to appear in a bank transfer file.
 */
export function fabRowsForScope(rows: AssembledRow[], scope: "part1" | "part2"): FabSheetRow[] {
  return rows
    .filter((entry) => !heldForScope(entry, scope))
    // One routing definition, shared with cib-sheet.ts and the coverage report in
    // bank-coverage.ts. The decision is identical to the `trim().toUpperCase() === "FAB"` plus
    // non-empty-account test this replaces, so the file's contents do not move. What changes is
    // that whoever is NOT routed is now named by buildBankCoverage instead of vanishing.
    .filter((entry) => resolveBankRoute({ bankName: entry.bankName, bankAccount: entry.bankAccount }).route === "FAB")
    .map((entry) => ({
      fullName: entry.row.fullName,
      bankAccount: (entry.bankAccount ?? "").trim(),
      salary: scope === "part1" ? entry.row.firstPart : entry.row.secondPart,
    }))
    .filter((entry) => entry.salary > 0);
}

/**
 * FAB-bank Non-Employees Payroll rows (people paid a monthly salary with no
 * employee/HR_ID record — owner rule 2026-07-25/26 misses this without it, since
 * they are a completely separate data source from AssembledRow and don't run
 * through fabRowsForScope at all).
 *
 * Each entry's own `part` decides which file carries it (owner request
 * 2026-08-03). This used to hard-return [] for "part2", on the assumption that
 * every non-employee pays with Part 1 — so a second-installment non-employee
 * would have been left out of the bank transfer entirely and simply not get
 * paid. Zero-amount and account-less rows are still dropped, same as employees.
 */
export function fabRowsForNonEmployees(
  nonEmployees: NonEmployeePayrollRow[],
  scope: "part1" | "part2",
): FabSheetRow[] {
  const part = scope === "part1" ? "first" : "second";
  return nonEmployees
    .filter((entry) => entry.part === part)
    .filter((entry) => resolveBankRoute({ bankName: entry.bankName, bankAccount: entry.bankAccount }).route === "FAB")
    .map((entry) => ({
      fullName: entry.fullNameEn,
      bankAccount: (entry.bankAccount ?? "").trim(),
      salary: entry.totalSalary,
    }))
    .filter((entry) => entry.salary > 0);
}

/**
 * The literal FAB bulk-upload workbook: one unbranded sheet, 9 columns, zero
 * cover page, zero extra columns, zero protection (finance may need to hand-
 * adjust a value before submitting to the bank) — matching the reference
 * file's own structure exactly.
 */
export async function buildFabSheetWorkbook(input: {
  rows: FabSheetRow[];
  valueDate: Date;
  /**
   * Column D's header. Part 1 keeps the reference file's literal "Salary" —
   * Part 2 reads "Expense" instead (owner request 2026-08-08: the money in
   * this column on a Part 2 file is expenses/additions, not a salary figure,
   * and finance reads it that way). Same underlying number either way — this
   * only changes the label FAB's own file never actually validates.
   */
  salaryColumnLabel?: "Salary" | "Expense";
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");

  sheet.columns = [
    { header: "COMPANY ACCOUNT NUMBER", key: "companyAccount", width: 28.86 },
    { header: "Title", key: "title", width: 5.14 },
    { header: "Full_Name", key: "fullName", width: 73.57 },
    { header: input.salaryColumnLabel ?? "Salary", key: "salary", width: 9.29 },
    { header: "Currency", key: "currency", width: 9.71 },
    { header: "Employee Account_Number", key: "employeeAccount", width: 27.43 },
    { header: "Bank_Name", key: "bankName", width: 11.86 },
    { header: "Value Date", key: "valueDate", width: 11 },
    { header: "Trns_Desc", key: "trnsDesc", width: 9.14 },
  ];

  // Header: bold Arial 10, solid light-yellow fill (ARGB FFFFFF99 — indexed
  // color 43 in the reference file), centered — verified cell-by-cell
  // against FAB.xlsx on 2026-07-26.
  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = { name: "Arial", size: 10, bold: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF99" } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });

  for (const row of input.rows) {
    const excelRow = sheet.addRow({
      companyAccount: FAB_COMPANY_ACCOUNT_NUMBER,
      title: FAB_TITLE,
      fullName: row.fullName.toUpperCase(),
      salary: row.salary,
      currency: FAB_CURRENCY,
      employeeAccount: row.bankAccount,
      bankName: FAB_BANK_LABEL,
      valueDate: input.valueDate,
      trnsDesc: FAB_TRNS_DESC,
    });
    excelRow.eachCell((cell) => {
      cell.font = { name: "Arial", size: 10 };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });
    excelRow.getCell("companyAccount").numFmt = "@";
    excelRow.getCell("employeeAccount").numFmt = "@";
    excelRow.getCell("salary").numFmt = "#,##0";
    excelRow.getCell("valueDate").numFmt = "dd/mm/yyyy;@";
  }

  return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
}
