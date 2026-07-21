import ExcelJS from "exceljs";

import { listSettlementLedger, type SettlementLedgerQuery } from "@/lib/attendance/settlement-ledger";
import {
  buildCoverSheet,
  phoenixBandHeader,
  sanitizeSheetName,
  writeTable,
  VALUE_FMT,
} from "@/lib/export/phoenix-xlsx-style";

export async function generateApprovedDeductionsWorkbook(query: SettlementLedgerQuery): Promise<ExcelJS.Workbook> {
  const ledger = await listSettlementLedger(query);

  // Filter only lines that resulted in a real deduction (dispute_upheld drops deductionDays to 0)
  const approvedDeductions = ledger.filter(
    (row) =>
      Number(row.deductionDays) > 0 &&
      (row.action === "confirmed" || row.action === "auto_confirmed" || row.action === "dispute_rejected"),
  );

  const workbook = new ExcelJS.Workbook();

  // 1. Cover Sheet
  buildCoverSheet(workbook, {
    confidentialNote: "This report contains confidential employee payroll deductions. Do not distribute.",
    rows: [
      ["Export type", "Approved Deductions"],
      ["Date From", query.dateFrom ?? "All time"],
      ["Date To", query.dateTo ?? "All time"],
      ["Employee Scope", query.employeeHrId ?? "All Employees"],
      ["Total Records", String(approvedDeductions.length)],
      ["Generated on", new Date().toISOString()],
    ],
    subtitle: "Consolidated fingerprint and flexible hours deductions",
    title: "Approved Deductions Export",
  });

  // 2. Summarized Tab
  const summaryMap = new Map<string, { name: string; days: number; value: number }>();
  for (const row of approvedDeductions) {
    const existing = summaryMap.get(row.employeeHrId) ?? { days: 0, name: row.employeeName, value: 0 };
    existing.days += row.deductionDays;
    existing.value += row.deductionValue;
    summaryMap.set(row.employeeHrId, existing);
  }

  const summaryRows = Array.from(summaryMap.entries())
    .map(([hrId, data]) => ({ hrId, ...data }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name)); // Sort by highest value then name

  const summarySheet = workbook.addWorksheet(sanitizeSheetName("Summarized"));
  phoenixBandHeader(summarySheet, 4, "Summarized Deductions", "Grouped by employee");

  const totalSummaryDays = summaryRows.reduce((sum, r) => sum + r.days, 0);
  const totalSummaryValue = summaryRows.reduce((sum, r) => sum + r.value, 0);

  writeTable(summarySheet, 5, {
    columns: [
      { label: "Employee HR ID", width: 18 },
      { label: "Employee Name", width: 35 },
      { label: "Total Deduction Days", right: true, width: 22 },
      { label: "Total Deduction Value", numFmt: VALUE_FMT, right: true, width: 22 },
    ],
    rows: summaryRows.map((row) => [row.hrId, row.name, row.days, row.value]),
    title: "Deductions Summary",
    totals: ["Total", "", totalSummaryDays, totalSummaryValue],
  });

  // 3. Detailed Tab
  const detailSheet = workbook.addWorksheet(sanitizeSheetName("Detailed"));
  phoenixBandHeader(detailSheet, 8, "Detailed Deductions", "Line-by-line deduction records");

  const totalDetailDays = approvedDeductions.reduce((sum, r) => sum + r.deductionDays, 0);
  const totalDetailValue = approvedDeductions.reduce((sum, r) => sum + r.deductionValue, 0);

  writeTable(detailSheet, 5, {
    columns: [
      { label: "Employee HR ID", width: 18 },
      { label: "Employee Name", width: 35 },
      { label: "Date", width: 15 },
      { label: "Issue", width: 18 },
      { label: "Deduction Days", right: true, width: 18 },
      { label: "Deduction Value", numFmt: VALUE_FMT, right: true, width: 18 },
      { label: "Reason", width: 45 },
      { label: "Decided By", width: 20 },
    ],
    rows: approvedDeductions.map((row) => [
      row.employeeHrId,
      row.employeeName,
      row.workDate,
      row.lineStatus,
      row.deductionDays,
      row.deductionValue,
      row.reason ?? "—",
      row.actorHrId ?? "System",
    ]),
    title: "All Approved Deductions",
    totals: ["Total", "", "", "", totalDetailDays, totalDetailValue, "", ""],
  });

  return workbook;
}
