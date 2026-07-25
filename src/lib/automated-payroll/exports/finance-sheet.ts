import ExcelJS from "exceljs";

import { buildCoverSheet } from "@/lib/export/phoenix-xlsx-style";
import { payrollSheetHeaders } from "@/lib/payroll/salary-sheet-fields";

import type { AssembledRow } from "../assemble.ts";
import { monthLabel } from "../notify.ts";
import type { MonthlySalaryRun, NonEmployeePayrollRow } from "../types.ts";
import { appendNonEmployeesSection, bankExtraColumns, PART1_HEADERS, writePayrollWorksheet } from "./sheet.ts";

/**
 * Finance download (export-only): the full or Part-1 sheet with EVERY cell locked
 * and only two appended columns — "Finance Edit" (numeric) + "Finance Edit Reason"
 * (text) — left editable for finance's offline execution notes. No re-upload path.
 */
export async function buildFinanceSheetWorkbook(input: {
  run: MonthlySalaryRun;
  rows: AssembledRow[];
  scope: "part1" | "full";
  /** People paid a monthly salary with no employee/HR_ID record (Part 1 scope only). */
  nonEmployees?: NonEmployeePayrollRow[];
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const label = monthLabel(input.run.month, input.run.year);
  const scopeLabel = input.scope === "part1" ? "Part 1 (first installment)" : "Full monthly sheet";

  buildCoverSheet(workbook, {
    title: "Automated Payroll — Finance Sheet (locked)",
    subtitle: `${label} · ${scopeLabel}`,
    rows: [
      ["Period", label],
      ["Scope", scopeLabel],
      ["Employees", String(input.rows.length)],
      ["Protection", "All cells locked except Finance Edit / Finance Edit Reason"],
    ],
    confidentialNote:
      "CONFIDENTIAL — Locked payroll sheet for finance execution. Only the Finance Edit columns are editable.",
  });

  const { sheet, nextRow, firstPartTotal, monthSalaryTotal } = await writePayrollWorksheet(workbook, {
    sheetName: input.scope === "part1" ? "Part 1 (Finance)" : "Payroll (Finance)",
    title: input.scope === "part1" ? "Part 1 — Finance (locked)" : "Full Sheet — Finance (locked)",
    subtitle: `${label} · read-only except Finance Edit columns`,
    run: input.run,
    rows: input.rows,
    headers: input.scope === "part1" ? PART1_HEADERS : [...payrollSheetHeaders],
    extraColumns: [
      ...(input.scope === "part1" ? bankExtraColumns() : []),
      { label: "Finance Edit", kind: "money" },
      { label: "Finance Edit Reason", kind: "text" },
    ],
    protect: true,
  });

  // Finance sees the same complete picture as HR: non-employees are appended to
  // BOTH scopes, against whichever employee total that scope pays out.
  appendNonEmployeesSection(sheet, {
    startRow: nextRow,
    rows: input.nonEmployees ?? [],
    employeeTotal: input.scope === "part1" ? firstPartTotal : monthSalaryTotal,
    employeeTotalLabel: input.scope === "part1" ? "First Part" : "Month Salary",
  });

  return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
}
