import ExcelJS from "exceljs";

import { calculateDeductionAmountFromBaseSalary } from "@/lib/deductions-governance/calculations";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { compactHrKey } from "./feeders.ts";

/**
 * Downloadable xlsx reports for the Payroll Copilot's deduction/expense tabs —
 * the backup sheets behind the monthly payroll sheet (CRM no-activity,
 * fingerprint, unpaid-vacation, expenses). Each report is built from the SAME
 * live data the tab shows, so "download" and "on screen" always agree.
 *
 * Styling mirrors the existing payroll exports (statutory-summary route): a navy
 * title band, an orange header row, frozen header, an optional totals row.
 */

export type ReportColumn = {
  header: string;
  /** money cells get the EGP number format + right alignment */
  money?: boolean;
  /** column width; defaults from the header length */
  width?: number;
};

export type ReportCell = string | number | null;

const NAVY = "FF0F172A";
const ORANGE = "FFF97316";
const MONEY_FMT = "#,##0.00";

export async function buildReportWorkbook(input: {
  sheetName: string;
  title: string;
  subtitle?: string;
  columns: ReportColumn[];
  rows: ReportCell[][];
  /** optional totals row aligned to columns (null cells are skipped) */
  totals?: ReportCell[];
}): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(input.sheetName);
  const n = input.columns.length;

  ws.columns = input.columns.map((c) => ({ width: c.width ?? Math.max(c.header.length + 4, 12) }));

  // Title band (row 1)
  ws.mergeCells(1, 1, 1, n);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = input.title;
  titleCell.font = { name: "Arial", size: 13, bold: true, color: { argb: "FFFFFFFF" } };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  titleCell.alignment = { vertical: "middle" };
  ws.getRow(1).height = 24;

  // Subtitle (row 2, optional)
  let headerRowIdx = 2;
  if (input.subtitle) {
    ws.mergeCells(2, 1, 2, n);
    const sub = ws.getCell(2, 1);
    sub.value = input.subtitle;
    sub.font = { name: "Arial", size: 9, italic: true, color: { argb: "FF64748B" } };
    sub.alignment = { vertical: "middle", wrapText: true };
    ws.getRow(2).height = 26;
    headerRowIdx = 3;
  }

  // Header row
  const headerRow = ws.getRow(headerRowIdx);
  input.columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.header;
    cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ORANGE } };
    cell.alignment = { horizontal: col.money ? "right" : "left", vertical: "middle", wrapText: true };
  });
  headerRow.height = 26;
  ws.views = [{ state: "frozen", ySplit: headerRowIdx }];

  // Data rows
  for (const row of input.rows) {
    const r = ws.addRow(row);
    input.columns.forEach((col, i) => {
      const cell = r.getCell(i + 1);
      cell.font = { name: "Arial", size: 10 };
      if (col.money) {
        cell.numFmt = MONEY_FMT;
        cell.alignment = { horizontal: "right" };
      }
    });
  }

  // Totals row
  if (input.totals) {
    const t = ws.addRow(input.totals);
    input.columns.forEach((col, i) => {
      const cell = t.getCell(i + 1);
      cell.font = { name: "Arial", size: 10, bold: true };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
      if (col.money) {
        cell.numFmt = MONEY_FMT;
        cell.alignment = { horizontal: "right" };
      }
    });
  }

  // ExcelJS's writeBuffer() returns its own `Buffer extends ArrayBuffer`, which
  // is a valid Response BodyInit as-is (mirrors the statutory-summary export).
  // Do NOT wrap in Buffer.from() — Node's Buffer is not assignable to BodyInit.
  return wb.xlsx.writeBuffer();
}

/**
 * Map of compact HR key -> hire date (YYYY-MM-DD). Fetched unfiltered and keyed
 * by the normalized/compact HR id (never filter employees by a pre-normalized
 * hr_id — the column's casing/hyphenation is not guaranteed; a recurring bug
 * class in this codebase). Defensive: returns an empty map on any failure so an
 * export still produces the sheet (hire-date column just shows blank).
 */
export async function getHireDateMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.from("employees").select("hr_id,hire_date");
    if (error) {
      console.error("[payroll-copilot:report-exports] hire-date load failed:", error);
      return map;
    }
    for (const row of (data ?? []) as Array<{ hr_id: string; hire_date: string | null }>) {
      const key = compactHrKey(String(row.hr_id ?? ""));
      if (key) map.set(key, row.hire_date ? String(row.hire_date).slice(0, 10) : "");
    }
  } catch (error) {
    console.error("[payroll-copilot:report-exports] hire-date load threw:", error);
  }
  return map;
}

/**
 * Base-salary map, shared with the payroll-sheet assembler's mandatory
 * no-activity totals (deductions-review.ts) so the sheet and this export
 * always agree on the same estimate.
 */
export { getBaseSalaryMap } from "./feeders.ts";

export function xlsxResponse(buffer: ArrayBuffer, filename: string): Response {
  return new Response(buffer, {
    headers: {
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      // Prevent the browser from caching payroll exports — a stale cached file
      // would silently show pre-decision data even after the CEO has made changes.
      "Cache-Control": "no-store",
    },
  });
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "June 2026" for a payroll period (month is 1-based). */
export function formatPeriodLabel(period: { month: number; year: number }): string {
  const name = MONTH_NAMES[period.month - 1] ?? `Month ${period.month}`;
  return `${name} ${period.year}`;
}

/** Slug for filenames: "June_2026". */
export function periodFileSlug(period: { month: number; year: number }): string {
  const name = MONTH_NAMES[period.month - 1] ?? `M${period.month}`;
  return `${name}_${period.year}`;
}

/** A CRM/Fingerprint deduction candidate row (subset of DeductionInboxRow) needed for the sheet. */
export type DeductionExportRow = {
  employeeCode: string;
  employeeHrIdCompact: string;
  employeeName: string | null;
  deductionValue: number;
  deductionUnit: string;
  estimatedAmount: number | null;
  /** the specific flagged days (ISO dates) behind the count */
  dates: string[];
  decision: { decisionStatus?: string; appliedDeductionValue?: number | null; appliedAmount?: number | null } | null;
};

/** CRM no-activity / Fingerprint deductions report (Name, Hire Date, Qty, Value). */
export async function buildDeductionReportWorkbook(input: {
  title: string;
  subtitle: string;
  qtyHeader: string;
  rows: DeductionExportRow[];
  hireDates: Map<string, string>;
  /** base salaries (compact HR key -> salary) used to estimate value where no amount is computed yet */
  baseSalaries?: Map<string, number>;
}): Promise<ArrayBuffer> {
  const columns: ReportColumn[] = [
    { header: "HR ID", width: 10 },
    { header: "Name", width: 40 },
    { header: "Hire Date", width: 13 },
    { header: input.qtyHeader, width: 18 },
    { header: "Dates (problem days)", width: 42 },
    { header: "Value (EGP)", width: 15, money: true },
    { header: "Value Basis", width: 14 },
    { header: "Status", width: 24 },
  ];
  let totalQty = 0;
  let totalValue = 0;
  const rows: ReportCell[][] = input.rows.map((r) => {
    const qty = r.decision?.appliedDeductionValue ?? r.deductionValue;
    // Prefer the decided/persisted amount; else the stored estimate; else, for
    // day-based deductions, estimate from base salary (base / 30 x days) — the
    // same formula approval uses — so pending rows aren't misleading zeros.
    const decided = r.decision?.appliedAmount ?? r.estimatedAmount;
    let value = decided ?? 0;
    let basis = decided != null ? (r.decision?.appliedAmount != null ? "Approved" : "Estimate") : "";
    if (decided == null && r.deductionUnit === "days") {
      const estimate = calculateDeductionAmountFromBaseSalary({
        baseSalary: input.baseSalaries?.get(r.employeeHrIdCompact),
        deductionDays: qty,
      });
      if (estimate != null) {
        value = estimate;
        basis = "Estimate";
      } else {
        basis = "No base salary";
      }
    }
    value = round2(value);
    totalQty += qty;
    totalValue += value;
    return [
      r.employeeCode,
      r.employeeName ?? r.employeeCode,
      input.hireDates.get(r.employeeHrIdCompact) ?? "",
      qty,
      (r.dates ?? []).join(", "),
      value,
      basis,
      r.decision?.decisionStatus ?? "Pending",
    ];
  });
  return buildReportWorkbook({
    sheetName: "Deductions",
    title: input.title,
    subtitle: input.subtitle,
    columns,
    rows,
    totals: ["TOTAL", "", "", round2(totalQty), "", round2(totalValue), "", ""],
  });
}

export type VacationExportRow = {
  employeeHrId: string;
  employeeName: string | null;
  vacationType: string;
  startDate: string;
  endDate: string;
  unpaidDays: number;
  balanceDaysAvailable: number;
  salaryDeductionAmount: number;
  balanceAvailable: boolean;
  /** Present when partial-balance settlement is possible — not used by the xlsx builder itself. */
  balanceDaysToConsume?: number;
  remainingSalaryDays?: number;
  remainingSalaryDeductionAmount?: number;
  existingSettlement: { method: "salary" | "balance" | "partial_balance" | "defer_to_balance" } | null;
};

/** Unpaid-vacation (no-balance) report — days, remaining balance, salary deduction. */
export async function buildVacationReportWorkbook(input: {
  periodLabel: string;
  rows: VacationExportRow[];
  hireDates: Map<string, string>;
}): Promise<ArrayBuffer> {
  const columns: ReportColumn[] = [
    { header: "HR ID", width: 10 },
    { header: "Name", width: 38 },
    { header: "Hire Date", width: 13 },
    { header: "Type", width: 12 },
    { header: "From", width: 12 },
    { header: "To", width: 12 },
    { header: "Unpaid Days", width: 13 },
    { header: "Balance Days Left", width: 16 },
    { header: "Salary Deduction (EGP)", width: 20, money: true },
    { header: "Settled As", width: 16 },
  ];
  let totalDays = 0;
  let totalDeduction = 0;
  const rows: ReportCell[][] = input.rows.map((r) => {
    let actualDeduction = r.salaryDeductionAmount;
    if (r.existingSettlement?.method === "balance" || r.existingSettlement?.method === "defer_to_balance") {
      actualDeduction = 0;
    } else if (r.existingSettlement?.method === "partial_balance") {
      actualDeduction = r.remainingSalaryDeductionAmount ?? 0;
    }

    totalDays += r.unpaidDays;
    totalDeduction += round2(actualDeduction);
    const settled = r.existingSettlement
      ? r.existingSettlement.method === "balance"
        ? "From balance"
        : r.existingSettlement.method === "partial_balance"
          ? "Partial (balance + salary)"
          : r.existingSettlement.method === "defer_to_balance"
            ? "Deferred to future balance"
            : "From salary"
      : r.balanceAvailable ? "Pending (balance available)" : "Pending (no balance)";
    return [
      r.employeeHrId,
      r.employeeName ?? r.employeeHrId,
      input.hireDates.get(compactHrKey(r.employeeHrId)) ?? "",
      r.vacationType,
      r.startDate,
      r.endDate,
      r.unpaidDays,
      round2(r.balanceDaysAvailable),
      round2(actualDeduction),
      settled,
    ];
  });
  return buildReportWorkbook({
    sheetName: "Unpaid Vacation",
    title: `Unpaid Vacation — ${input.periodLabel}`,
    subtitle:
      "AV/leave with no balance to cover it. If the employee has balance it is taken from balance; the shortfall is a salary deduction.",
    columns,
    rows,
    totals: ["TOTAL", "", "", "", "", "", totalDays, "", round2(totalDeduction), ""],
  });
}

export type ExpenseExportRow = {
  employeeHrId: string;
  employeeName: string | null;
  dateFrom: string;
  dateTo: string;
  locationFrom: string;
  locationTo: string;
  km: number | null;
  type: string;
  travelCost: number;
  allowance: number;
  existingDecision: { decision: "include" | "defer" } | null;
};

/**
 * Outstation expenses report — the detail behind the payroll Expenses
 * column. Expenses lag one month (owner-dictated rule): a payroll period
 * pays out the PRIOR month's approved outstation trips, so `sourceMonthLabel`
 * (e.g. "May 2026") is what's actually queried and shown — deliberately
 * distinct from `periodLabel` (e.g. "June 2026", the payroll this feeds).
 */
export async function buildExpenseReportWorkbook(input: {
  periodLabel: string;
  sourceMonthLabel: string;
  rows: ExpenseExportRow[];
  hireDates: Map<string, string>;
}): Promise<ArrayBuffer> {
  const columns: ReportColumn[] = [
    { header: "HR ID", width: 10 },
    { header: "Name", width: 34 },
    { header: "Hire Date", width: 13 },
    { header: "Date From", width: 12 },
    { header: "Date To", width: 12 },
    { header: "Location From", width: 18 },
    { header: "Location To", width: 18 },
    { header: "KM", width: 8, money: true },
    { header: "Type", width: 14 },
    { header: "Travel Cost (EGP)", width: 16, money: true },
    { header: "Allowance (EGP)", width: 15, money: true },
    { header: "Decision", width: 18 },
  ];
  let totalTravel = 0;
  let totalAllowance = 0;
  const rows: ReportCell[][] = input.rows.map((r) => {
    totalTravel += round2(r.travelCost);
    totalAllowance += round2(r.allowance);
    return [
      r.employeeHrId,
      r.employeeName ?? r.employeeHrId,
      input.hireDates.get(compactHrKey(r.employeeHrId)) ?? "",
      r.dateFrom,
      r.dateTo,
      r.locationFrom,
      r.locationTo,
      r.km,
      r.type,
      round2(r.travelCost),
      round2(r.allowance),
      r.existingDecision ? (r.existingDecision.decision === "include" ? "Include this run" : "Defer to next month") : "Pending",
    ];
  });
  return buildReportWorkbook({
    sheetName: "Expenses",
    title: `Outstation Expenses — ${input.sourceMonthLabel} trips, paid in ${input.periodLabel} payroll`,
    subtitle:
      `Expenses lag one month: ${input.periodLabel} payroll pays out HR-approved outstation expense requests from ${input.sourceMonthLabel} (not ${input.periodLabel}). 'Include' amounts feed the payroll Expenses column (paid in Part 2).`,
    columns,
    rows,
    totals: ["TOTAL", "", "", "", "", "", "", "", "", round2(totalTravel), round2(totalAllowance), ""],
  });
}

export type HolidayBridgingExportRow = {
  employeeHrId: string;
  employeeName: string | null;
  vacationType: string;
  bridgingDate: string;
  adjacentTo: "before" | "after";
  holidayName: string;
  holidayStartDate: string;
  holidayEndDate: string;
  salaryDeductionAmount: number;
  excluded: boolean;
};

/** National-holiday-bridging mandatory leave-deduction report — one row per (employee, bridging day). */
export async function buildHolidayBridgingReportWorkbook(input: {
  periodLabel: string;
  rows: HolidayBridgingExportRow[];
  hireDates: Map<string, string>;
}): Promise<ArrayBuffer> {
  const columns: ReportColumn[] = [
    { header: "HR ID", width: 10 },
    { header: "Name", width: 34 },
    { header: "Hire Date", width: 13 },
    { header: "Type", width: 12 },
    { header: "Bridging Date", width: 14 },
    { header: "Adjacent To", width: 12 },
    { header: "Holiday", width: 22 },
    { header: "Holiday Dates", width: 22 },
    { header: "Value (EGP)", width: 15, money: true },
    { header: "Status", width: 16 },
  ];
  let totalValue = 0;
  const rows: ReportCell[][] = input.rows.map((r) => {
    const value = round2(r.excluded ? 0 : r.salaryDeductionAmount);
    totalValue += value;
    const holidayDates =
      r.holidayStartDate === r.holidayEndDate ? r.holidayStartDate : `${r.holidayStartDate} to ${r.holidayEndDate}`;
    return [
      r.employeeHrId,
      r.employeeName ?? r.employeeHrId,
      input.hireDates.get(compactHrKey(r.employeeHrId)) ?? "",
      r.vacationType,
      r.bridgingDate,
      r.adjacentTo === "before" ? "Before holiday" : "After holiday",
      r.holidayName,
      holidayDates,
      value,
      r.excluded ? "Excluded" : "Mandatory",
    ];
  });
  return buildReportWorkbook({
    sheetName: "Holiday Bridging",
    title: `National-Holiday Bridging Deductions — ${input.periodLabel}`,
    subtitle:
      "Leave taken directly before or after a national holiday is a mandatory salary deduction (base salary / calendar days x 1 day), regardless of vacation balance. Excluded rows do not count toward the payroll sheet.",
    columns,
    rows,
    totals: ["TOTAL", "", "", "", "", "", "", "", round2(totalValue), ""],
  });
}
