import ExcelJS from "exceljs";

import { buildCoverSheet } from "@/lib/export/phoenix-xlsx-style";
import { payrollSheetHeaders } from "@/lib/payroll/salary-sheet-fields";

import type { AssembledRow } from "../assemble.ts";
import { monthLabel } from "../notify.ts";
import type { MonthlySalaryRun } from "../types.ts";
import { PART1_HEADERS, writePayrollWorksheet } from "./sheet.ts";

/**
 * Finance download (export-only): the full or Part-1 sheet with EVERY cell locked
 * and only two appended columns — "Finance Edit" (numeric) + "Finance Edit Reason"
 * (text) — left editable for finance's offline execution notes. No re-upload path.
 */
export async function buildFinanceSheetWorkbook(input: {
  run: MonthlySalaryRun;
  rows: AssembledRow[];
  scope: "part1" | "full";
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

  await writePayrollWorksheet(workbook, {
    sheetName: input.scope === "part1" ? "Part 1 (Finance)" : "Payroll (Finance)",
    title: input.scope === "part1" ? "Part 1 — Finance (locked)" : "Full Sheet — Finance (locked)",
    subtitle: `${label} · read-only except Finance Edit columns`,
    run: input.run,
    rows: input.rows,
    headers: input.scope === "part1" ? PART1_HEADERS : [...payrollSheetHeaders],
    extraColumns: [
      { label: "Finance Edit", kind: "money" },
      { label: "Finance Edit Reason", kind: "text" },
    ],
    protect: true,
  });

  return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
}
